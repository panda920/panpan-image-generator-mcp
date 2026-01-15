#!/usr/bin/env node

/**
 * 自定义 Gemini MCP 服务器
 * 支持使用第三方 API 进行图像生成
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
  InitializedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置 - 所有 API Key 必须通过环境变量提供
const API_CONFIG = {
  apiKey: process.env.GEMINI_API_KEY || "",
  apiBase: process.env.GEMINI_API_BASE || "https://openrouter.ai/api/v1",
  // 模型配置：
  // - Nano Banana Pro (高质量): google/gemini-3-pro-image-preview (google-ai-studio 供应商)
  // - Seedream (普通版/Flash): bytedance-seed/seedream-4.5
  // - GLM-Image (智谱): glm-image
  modelNanoBanana: process.env.GEMINI_MODEL || "google/gemini-3-pro-image-preview",
  modelSeedream: "bytedance-seed/seedream-4.5",
  modelGlmImage: "glm-image",
  // 智谱 API 配置
  zhipuApiKey: process.env.ZHIPU_API_KEY || "",
  zhipuApiBase: "https://open.bigmodel.cn/api/paas/v4",
  // 修复 URL 拼接问题：如果 API_BASE 已经包含 /v1，则不再添加
  chatApiUrl: process.env.GEMINI_API_BASE
    ? (process.env.GEMINI_API_BASE.endsWith('/v1')
        ? `${process.env.GEMINI_API_BASE}/chat/completions`
        : `${process.env.GEMINI_API_BASE}/v1/chat/completions`)
    : "https://openrouter.ai/api/v1/chat/completions",
  // 默认输出目录，但会优先使用项目路径
  outputDir: process.env.OUTPUT_DIR || path.join(__dirname, 'generated-images'),
  // 当前工作目录（项目路径）
  projectDir: process.env.PROJECT_DIR || process.cwd()
};

// 确保输出目录存在
async function ensureOutputDir() {
  try {
    await fs.access(API_CONFIG.outputDir);
  } catch {
    await fs.mkdir(API_CONFIG.outputDir, { recursive: true });
  }
}

// 不再对提示词进行优化，让大模型自由发挥创意

// 图像生成函数（使用对话式接口）
// imageConfig: { aspect_ratio?: string, image_size?: '1K' | '2K' | '4K' }
async function generateImage(prompt, saveToFilePath = null, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  try {
    console.error(`生成图像...`);
    
    // 构建请求体
    const requestBody = {
      model: model,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      modalities: ["image", "text"],
      stream: false,
      max_tokens: 4000
    };
    
    // 如果是 Gemini 模型，添加 image_config（默认 1K，加快生成速度）
    if (model.includes('gemini') || model.includes('nano-banana')) {
      requestBody.image_config = imageConfig || { image_size: '1K' };
          }
    
    const response = await fetch(API_CONFIG.chatApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
    }

    // 处理响应
    const responseText = await response.text();
    
    let imageUrl = null;
    let fullContent = '';
    let imageBase64 = null;
    
    // 首先尝试解析为标准 JSON 响应（OpenRouter 格式）
    try {
      const jsonData = JSON.parse(responseText);
            
      if (jsonData.choices && jsonData.choices[0] && jsonData.choices[0].message) {
        const message = jsonData.choices[0].message;
        const messageContent = message.content;
        
        // OpenRouter 图像生成模型返回的图像在 message.images 字段中
        if (message.images && Array.isArray(message.images)) {
          for (const img of message.images) {
            if (img.type === 'image_url' && img.image_url && img.image_url.url) {
              const dataUrl = img.image_url.url;
              // 解析 data:image/png;base64,... 格式
              const base64Match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
              if (base64Match) {
                imageBase64 = base64Match[1];
                              }
            }
          }
        }
        
        // OpenRouter 返回的 content 可能是数组（包含文本和图像）
        if (!imageBase64 && Array.isArray(messageContent)) {
          for (const part of messageContent) {
            if (part.type === 'text') {
              fullContent += part.text || '';
            } else if (part.type === 'image' && part.inline_data) {
              // OpenRouter 图像生成返回的格式
              imageBase64 = part.inline_data.data;
              console.error(`找到 inline_data 图像，mime_type: ${part.inline_data.mime_type}, 长度: ${imageBase64.length}`);
            }
          }
        } else if (typeof messageContent === 'string') {
          fullContent = messageContent;
        }
      }
    } catch (e) {
      console.error(`JSON 解析失败，尝试流式解析: ${e.message}`);
      
      // 回退到流式响应解析
      const lines = responseText.split('\n').filter(line => line.trim());
      console.error(`总行数: ${lines.length}`);
      
      for (const line of lines) {
        try {
          if (line.trim().startsWith('data:')) {
            const jsonStr = line.replace('data: ', '');
            if (jsonStr.trim() === '[DONE]') {
              continue;
            }
            
            const data = JSON.parse(jsonStr);
            if (data.choices && data.choices[0]) {
              const choice = data.choices[0];
              
              // 处理 delta 格式（流式）
              if (choice.delta && choice.delta.content) {
                const content = choice.delta.content;
                if (Array.isArray(content)) {
                  for (const part of content) {
                    if (part.type === 'text') {
                      fullContent += part.text || '';
                    } else if (part.type === 'image' && part.inline_data) {
                      imageBase64 = part.inline_data.data;
                      console.error(`找到流式 inline_data 图像，长度: ${imageBase64.length}`);
                    }
                  }
                } else if (typeof content === 'string') {
                  fullContent += content;
                }
              }
              
              // 处理 message 格式（非流式）
              if (choice.message && choice.message.content) {
                const content = choice.message.content;
                if (Array.isArray(content)) {
                  for (const part of content) {
                    if (part.type === 'text') {
                      fullContent += part.text || '';
                    } else if (part.type === 'image' && part.inline_data) {
                      imageBase64 = part.inline_data.data;
                      console.error(`找到 message inline_data 图像，长度: ${imageBase64.length}`);
                    }
                  }
                } else if (typeof content === 'string') {
                  fullContent += content;
                }
              }
            }
          }
        } catch (parseErr) {
          console.error(`解析行时出错: ${parseErr.message}`);
          continue;
        }
      }
    }
    
    console.error(`完整内容长度: ${fullContent.length}`);
    console.error(`找到 base64 图像: ${imageBase64 ? '是' : '否'}`);
    
    // 如果没有找到 inline_data，尝试从文本内容中查找
    if (!imageUrl && !imageBase64) {
      const fullUrlMatch = fullContent.match(/https?:\/\/[^\s\)]+\.(jpg|jpeg|png|gif|webp)/i);
      if (fullUrlMatch) {
        imageUrl = fullUrlMatch[0];
        console.error(`从完整内容中找到图像URL: ${imageUrl}`);
      }
      
      const fullBase64Match = fullContent.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
      if (fullBase64Match) {
        imageBase64 = fullBase64Match[1];
        console.error(`从完整内容中找到base64图像数据，长度: ${imageBase64.length}`);
      }
    }
    
    let imageBuffer;
    
    if (imageBase64) {
      // 直接从base64解码图像
      console.error('从响应中找到 base64 图像数据');
      imageBuffer = Buffer.from(imageBase64, 'base64');
    } else if (imageUrl) {
      // 从URL下载图像
      console.error(`获取到图像 URL: ${imageUrl}`);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`下载图像失败: ${imageResponse.status}`);
      }
      imageBuffer = await imageResponse.buffer();
    } else {
      throw new Error('未在响应中找到图像URL或base64数据，可能需要调整提示词');
    }
    
    // 如果没有指定保存路径，生成默认路径（优先使用项目路径）
    if (!saveToFilePath) {
      // 优先使用项目路径，如果没有则使用默认输出目录
      const targetDir = API_CONFIG.projectDir || API_CONFIG.outputDir;
      try {
        await fs.access(targetDir);
      } catch {
        await fs.mkdir(targetDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safePrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
      // 根据响应类型确定扩展名
      const ext = imageBase64 && responseText.includes('image/jpeg') ? 'jpg' : 'png';
      saveToFilePath = path.join(targetDir, `generated_${safePrompt}_${timestamp}.${ext}`);
    }

    // 保存图像
    await fs.writeFile(saveToFilePath, imageBuffer);
    console.error(`图像已保存到: ${saveToFilePath}`);

    return {
      success: true,
      message: `图像生成成功并保存到: ${saveToFilePath}`,
      filePath: saveToFilePath,
      prompt: prompt
    };

  } catch (error) {
    console.error('图像生成失败:', error);
    return {
      success: false,
      error: error.message,
      prompt: prompt
    };
  }
}

// 智谱 GLM-Image 图像生成函数
async function generateImageGlm(prompt, saveToFilePath = null, size = "1280x1280") {
  try {
    console.error(`[GLM-Image] 生成图像，提示词: ${prompt}`);

    const response = await fetch(`${API_CONFIG.zhipuApiBase}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.zhipuApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: API_CONFIG.modelGlmImage,
        prompt: prompt,
        size: size,
        watermark_enabled: false  // 关闭水印
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`智谱 API 请求失败: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.error(`[GLM-Image] API 响应:`, JSON.stringify(data, null, 2));
    
    // 智谱返回格式: { data: [{ url: "..." }] }
    if (!data.data || !data.data[0] || !data.data[0].url) {
      throw new Error('智谱 API 返回格式异常，未找到图像 URL');
    }
    
    const imageUrl = data.data[0].url;
    console.error(`[GLM-Image] 获取到图像 URL: ${imageUrl}`);
    
    // 下载图像
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`下载图像失败: ${imageResponse.status}`);
    }
    const imageBuffer = await imageResponse.buffer();
    
    // 如果没有指定保存路径，生成默认路径
    if (!saveToFilePath) {
      const targetDir = API_CONFIG.projectDir || API_CONFIG.outputDir;
      try {
        await fs.access(targetDir);
      } catch {
        await fs.mkdir(targetDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safePrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
      saveToFilePath = path.join(targetDir, `glm_${safePrompt}_${timestamp}.png`);
    }

    // 保存图像
    await fs.writeFile(saveToFilePath, imageBuffer);
    console.error(`[GLM-Image] 图像已保存到: ${saveToFilePath}`);

    return {
      success: true,
      message: `图像生成成功并保存到: ${saveToFilePath}`,
      filePath: saveToFilePath,
      prompt: prompt,
      model: 'glm-image'
    };

  } catch (error) {
    console.error('[GLM-Image] 图像生成失败:', error);
    return {
      success: false,
      error: error.message,
      prompt: prompt,
      model: 'glm-image'
    };
  }
}

// 智谱 GLM-Image 批量生成
async function generateImageGlmBatch(batchRequests = [], concurrency = 3, size = "1024x1024") {
  if (!Array.isArray(batchRequests) || batchRequests.length === 0) {
    throw new Error('缺少批量请求列表，需提供 [{ prompt, saveToFilePath? }, ...]');
  }

  const results = [];
  const queue = batchRequests.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const { prompt, saveToFilePath } = queue.shift();
      try {
        if (!prompt) {
          results.push({ success: false, error: '缺少 prompt', prompt });
          continue;
        }
        const result = await generateImageGlm(prompt, saveToFilePath, size);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          error: error.message || String(error),
          prompt,
          model: 'glm-image'
        });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// 批量生成图像，支持并发执行
// imageConfig: { aspect_ratio?: string, image_size?: '1K' | '2K' | '4K' }
async function generateImageBatch(batchRequests = [], concurrency = 3, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  if (!Array.isArray(batchRequests) || batchRequests.length === 0) {
    throw new Error('缺少批量请求列表，需提供 [{ prompt, saveToFilePath? }, ...]');
  }

  // 控制并发数量
  const results = [];
  const queue = batchRequests.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const { prompt, saveToFilePath } = queue.shift();
      try {
        if (!prompt) {
          results.push({ success: false, error: '缺少 prompt', prompt });
          continue;
        }
        const result = await generateImage(prompt, saveToFilePath, model, imageConfig);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          error: error.message || String(error),
          prompt
        });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// 图像编辑函数（基于现有图像进行编辑）
// imageConfig: { aspect_ratio?: string, image_size?: '1K' | '2K' | '4K' }
async function editImage(imagePath, editPrompt, saveToFilePath = null, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  try {
    console.error(`编辑图像...`);
    
    // 读取原始图像
    const imageBuffer = await fs.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');

    // 构建请求体
    const requestBody = {
      model: model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: editPrompt
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      modalities: ["image", "text"],
      stream: false,
      max_tokens: 4000
    };
    
    // 如果是 Gemini 模型，添加 image_config（默认 1K，加快生成速度）
    if (model.includes('gemini') || model.includes('nano-banana')) {
      requestBody.image_config = imageConfig || { image_size: '1K' };
          }

    const response = await fetch(API_CONFIG.chatApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
    }

    // 处理响应
    const responseText = await response.text();
    
    let imageUrl = null;
    let fullContent = '';
    let imageBase64 = null;
    
    // 首先尝试解析为标准 JSON 响应（OpenRouter 格式）
    try {
      const jsonData = JSON.parse(responseText);
            
      if (jsonData.choices && jsonData.choices[0] && jsonData.choices[0].message) {
        const message = jsonData.choices[0].message;
        const messageContent = message.content;
        
        // OpenRouter 图像生成模型返回的图像在 message.images 字段中
        if (message.images && Array.isArray(message.images)) {
          for (const img of message.images) {
            if (img.type === 'image_url' && img.image_url && img.image_url.url) {
              const dataUrl = img.image_url.url;
              const base64Match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
              if (base64Match) {
                imageBase64 = base64Match[1];
                              }
            }
          }
        }
        
        // OpenRouter 返回的 content 可能是数组
        if (!imageBase64 && Array.isArray(messageContent)) {
          for (const part of messageContent) {
            if (part.type === 'text') {
              fullContent += part.text || '';
            } else if (part.type === 'image' && part.inline_data) {
              imageBase64 = part.inline_data.data;
                          }
          }
        } else if (typeof messageContent === 'string') {
          fullContent = messageContent;
        }
      }
    } catch (e) {
      console.error(`JSON 解析失败: ${e.message}`);
    }
    
    // 如果没有找到图像，尝试从文本内容中查找
    if (!imageUrl && !imageBase64 && fullContent) {
      const fullUrlMatch = fullContent.match(/https?:\/\/[^\s\)]+\.(jpg|jpeg|png|gif|webp)/i);
      if (fullUrlMatch) {
        imageUrl = fullUrlMatch[0];
              }
      
      const fullBase64Match = fullContent.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
      if (fullBase64Match) {
        imageBase64 = fullBase64Match[1];
              }
    }
    
    let editedImageBuffer;
    
    if (imageBase64) {
      // 直接从base64解码图像
            editedImageBuffer = Buffer.from(imageBase64, 'base64');
    } else if (imageUrl) {
      // 从URL下载图像
      console.error(`获取到编辑后图像 URL: ${imageUrl}`);
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        throw new Error(`下载图像失败: ${imageResponse.status}`);
      }
      editedImageBuffer = await imageResponse.buffer();
    } else {
      throw new Error('未在编辑响应中找到图像URL或base64数据，可能需要调整编辑提示词');
    }
    
    // 如果没有指定保存路径，生成默认路径
    if (!saveToFilePath) {
      await ensureOutputDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safePrompt = editPrompt.substring(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
      saveToFilePath = path.join(API_CONFIG.outputDir, `edited_${safePrompt}_${timestamp}.png`);
    }

    // 保存编辑后的图像
    await fs.writeFile(saveToFilePath, editedImageBuffer);
    console.error(`编辑完成: ${saveToFilePath}`);

    return {
      success: true,
      message: `图像编辑成功并保存到: ${saveToFilePath}`,
      filePath: saveToFilePath,
      originalPath: imagePath,
      editPrompt: editPrompt
    };

  } catch (error) {
    console.error('图像编辑失败:', error);
    return {
      success: false,
      error: error.message,
      originalPath: imagePath,
      editPrompt: editPrompt
    };
  }
}

// 图片转 PDF 函数（PPT 风格，每页一张图片，完美填充无空白）
async function imagesToPdf(imagePaths, outputPath, options = {}) {
  try {
    console.error(`转换 ${imagePaths.length} 张图片为 PDF...`);
    
    const { 
      maxWidth = 1920,   // 最大宽度（用于缩放超大图片）
      maxHeight = 1080   // 最大高度
    } = options;
    
    // 创建 PDF 文档（不预设页面尺寸，每页根据图片尺寸动态设置）
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0
    });
    
    // 创建写入流
    const { createWriteStream } = await import('fs');
    const writeStream = createWriteStream(outputPath);
    doc.pipe(writeStream);
    
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i];
      console.error(`处理图片 ${i + 1}/${imagePaths.length}: ${imagePath}`);
      
      // 读取图片并获取尺寸
      const imageBuffer = await fs.readFile(imagePath);
      const metadata = await sharp(imageBuffer).metadata();
      
      // 计算页面尺寸（完全匹配图片比例，无空白）
      let pageWidth = metadata.width;
      let pageHeight = metadata.height;
      
      // 如果图片太大，按比例缩小到合理尺寸
      if (pageWidth > maxWidth || pageHeight > maxHeight) {
        const scale = Math.min(maxWidth / pageWidth, maxHeight / pageHeight);
        pageWidth = Math.round(pageWidth * scale);
        pageHeight = Math.round(pageHeight * scale);
      }
      
      // 添加新页面（尺寸完全匹配图片）
      doc.addPage({
        size: [pageWidth, pageHeight],
        margin: 0
      });
      
      // 图片填满整个页面，无空白
      doc.image(imageBuffer, 0, 0, {
        width: pageWidth,
        height: pageHeight
      });
    }
    
    // 完成 PDF
    doc.end();
    
    // 等待写入完成
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    console.error(`PDF 已保存: ${outputPath}`);
    
    return {
      success: true,
      message: `成功将 ${imagePaths.length} 张图片转换为 PDF（无空白，完美填充）`,
      filePath: outputPath,
      pageCount: imagePaths.length
    };
    
  } catch (error) {
    console.error('图片转 PDF 失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 图片转 PPTX 函数
async function imagesToPptx(imagePaths, outputPath) {
  try {
    console.error(`转换 ${imagePaths.length} 张图片为 PPTX...`);
    
    // 动态导入 pptxgenjs
    const PptxGenJS = (await import('pptxgenjs')).default;
    const pptx = new PptxGenJS();
    
    // 设置 PPT 属性
    pptx.author = 'PanPan Image Generator';
    pptx.title = 'Generated Presentation';
    pptx.subject = 'Images to PPT';
    
    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i];
      console.error(`处理图片 ${i + 1}/${imagePaths.length}: ${imagePath}`);
      
      // 读取图片
      const imageBuffer = await fs.readFile(imagePath);
      const metadata = await sharp(imageBuffer).metadata();
      const base64Image = imageBuffer.toString('base64');
      
      // 计算图片比例
      const imgAspect = metadata.width / metadata.height;
      
      // 根据图片比例设置幻灯片尺寸（16:9 或 4:3 或自定义）
      if (imgAspect > 1.5) {
        // 宽屏 16:9
        pptx.defineLayout({ name: 'CUSTOM', width: 13.33, height: 7.5 });
      } else if (imgAspect < 0.67) {
        // 竖版 9:16
        pptx.defineLayout({ name: 'CUSTOM', width: 7.5, height: 13.33 });
      } else {
        // 标准 4:3
        pptx.defineLayout({ name: 'CUSTOM', width: 10, height: 7.5 });
      }
      pptx.layout = 'CUSTOM';
      
      // 添加幻灯片
      const slide = pptx.addSlide();
      
      // 获取幻灯片尺寸
      const slideWidth = pptx.presLayout.width;
      const slideHeight = pptx.presLayout.height;
      
      // 计算图片尺寸（填满幻灯片）
      let imgWidth, imgHeight, imgX, imgY;
      const slideAspect = slideWidth / slideHeight;
      
      if (imgAspect > slideAspect) {
        // 图片更宽，以高度为准填满
        imgHeight = slideHeight;
        imgWidth = imgHeight * imgAspect;
        imgX = (slideWidth - imgWidth) / 2;
        imgY = 0;
      } else {
        // 图片更高，以宽度为准填满
        imgWidth = slideWidth;
        imgHeight = imgWidth / imgAspect;
        imgX = 0;
        imgY = (slideHeight - imgHeight) / 2;
      }
      
      // 确定图片类型
      const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'png';
      const mimeType = ext === 'jpg' ? 'jpeg' : ext;
      
      // 添加图片到幻灯片（填满整个幻灯片）
      slide.addImage({
        data: `data:image/${mimeType};base64,${base64Image}`,
        x: 0,
        y: 0,
        w: '100%',
        h: '100%',
        sizing: { type: 'cover', w: '100%', h: '100%' }
      });
    }
    
    // 保存 PPTX
    await pptx.writeFile({ fileName: outputPath });
    
    console.error(`PPTX 已保存: ${outputPath}`);
    
    return {
      success: true,
      message: `成功将 ${imagePaths.length} 张图片转换为 PPTX`,
      filePath: outputPath,
      slideCount: imagePaths.length
    };
    
  } catch (error) {
    console.error('图片转 PPTX 失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// 创建服务器
const server = new Server(
  {
    name: 'custom-gemini-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 注册初始化处理器
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  console.error('收到初始化请求:', JSON.stringify(request, null, 2));

  const response = {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "custom-gemini-mcp",
      version: "1.0.0",
    },
  };

  console.error('发送初始化响应:', JSON.stringify(response, null, 2));
  return response;
});

// 注册初始化完成通知处理器
server.setNotificationHandler(InitializedNotificationSchema, async () => {
  console.error('MCP 服务器初始化完成');
});

// 注册工具列表处理器
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  console.error('收到工具列表请求:', JSON.stringify(request, null, 2));

  const tools = [
    {
      name: 'generate_image_nano',
      description: '使用 nano-banana-pro 模型生成图像。🎨 提示词请用中文书写，充分发挥创意和设计感，自由表达视觉想象。适合创意设计、艺术创作等场景。默认 2K 分辨率。⚠️ 重要：提示词必须非常详细，包括：1) 画面整体布局和构图 2) 具体的视觉元素和图标 3) 详细的配色方案（色值） 4) 文字内容、字体样式、排版效果 5) 光影、渐变、阴影等细节效果 6) 设计风格（扁平化/3D/手绘等）。提示词越详细，生成效果越好！',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图像生成的创意描述（必须用中文）。请非常详细地描述：画面布局、视觉元素、配色方案（含色值）、文字内容及样式、光影效果、设计风格等所有细节'
          },
          saveToFilePath: {
            type: 'string',
            description: '可选的保存文件路径（包含文件名和扩展名）'
          },
          image_size: {
            type: 'string',
            description: '图像分辨率：1K（标准）、2K（高清，默认）、4K（超高清）',
            enum: ['1K', '2K', '4K'],
            default: '2K'
          },
          aspect_ratio: {
            type: 'string',
            description: '宽高比，如 1:1、16:9、9:16、3:2、2:3、4:3、3:4、21:9 等',
            enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'generate_image_seedream',
      description: '使用 ByteDance Seedream 4.5 模型生成图像。🎨 字节跳动最新图像生成模型，效果优秀，速度快。提示词请用中文书写，注重设计感和视觉效果。⚠️ 重要：提示词必须非常详细，包括：1) 画面整体布局和构图 2) 具体的视觉元素和图标 3) 详细的配色方案（色值） 4) 文字内容、字体样式、排版效果 5) 光影、渐变、阴影等细节效果 6) 设计风格（扁平化/3D/手绘等）。提示词越详细，生成效果越好！',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图像生成的创意描述（必须用中文）。请非常详细地描述：画面布局、视觉元素、配色方案（含色值）、文字内容及样式、光影效果、设计风格等所有细节'
          },
          saveToFilePath: {
            type: 'string',
            description: '可选的保存文件路径（包含文件名和扩展名）'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'edit_image_nano',
      description: '使用 nano-banana-pro 模型编辑现有图像。🎨 默认 2K 分辨率。⚠️ 重要：编辑提示词应直接说明要怎么改，不要描述当前图片内容！例如："把背景改成蓝色"、"把文字改成XXX"、"添加一个太阳在右上角"、"把人物的衣服改成红色"。直接说修改指令，模型会自动理解图片内容。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: {
            type: 'string',
            description: '要编辑的原始图像文件路径'
          },
          editPrompt: {
            type: 'string',
            description: '编辑指令（中文）。直接说要怎么改，不要描述当前图片内容！例如："把背景改成蓝色"、"把文字改成XXX"、"添加一个太阳在右上角"'
          },
          saveToFilePath: {
            type: 'string',
            description: '可选的保存文件路径（包含文件名和扩展名）'
          },
          image_size: {
            type: 'string',
            description: '图像分辨率：1K（标准）、2K（高清，默认）、4K（超高清）',
            enum: ['1K', '2K', '4K'],
            default: '2K'
          },
          aspect_ratio: {
            type: 'string',
            description: '宽高比，如 1:1、16:9、9:16、3:2、2:3、4:3、3:4、21:9 等',
            enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
          }
        },
        required: ['imagePath', 'editPrompt']
      }
    },
    {
      name: 'edit_image_seedream',
      description: '使用 ByteDance Seedream 4.5 模型编辑现有图像。🎨 编辑提示词应直接说明要怎么改，不要描述当前图片内容！例如："把背景改成蓝色"、"把文字改成XXX"、"添加一个太阳在右上角"。直接说修改指令，模型会自动理解图片内容。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: {
            type: 'string',
            description: '要编辑的原始图像文件路径'
          },
          editPrompt: {
            type: 'string',
            description: '编辑指令（中文）。直接说要怎么改，不要描述当前图片内容！例如："把背景改成蓝色"、"把文字改成XXX"'
          },
          saveToFilePath: {
            type: 'string',
            description: '可选的保存文件路径（包含文件名和扩展名）'
          }
        },
        required: ['imagePath', 'editPrompt']
      }
    },
    {
      name: 'generate_image_glm',
      description: '使用智谱 GLM-Image 模型生成图像。🎨 智谱 AI 图像生成模型，适合科普教育、插图设计等场景。支持中文提示词，效果稳定。默认 1280x1280 高清尺寸，无水印。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图像生成的描述（中文）。详细描述画面内容、风格、元素等'
          },
          saveToFilePath: {
            type: 'string',
            description: '可选的保存文件路径（包含文件名和扩展名）'
          },
          size: {
            type: 'string',
            description: '图像尺寸，默认 1280x1280。推荐枚举值：1280x1280(默认), 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728',
            enum: ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728', '1024x1024', '768x1024', '1024x768'],
            default: '1280x1280'
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'generate_image_glm_batch',
      description: '使用智谱 GLM-Image 模型批量生成多张图像。🎨 支持并发执行，适合批量生成科普插图、教育素材等场景。默认 1280x1280 高清尺寸，无水印。',
      inputSchema: {
        type: 'object',
        properties: {
          requests: {
            type: 'array',
            description: '批量生成请求列表',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '图像生成的描述（中文）' },
                saveToFilePath: { type: 'string', description: '可选的保存路径' }
              },
              required: ['prompt']
            }
          },
          concurrency: {
            type: 'number',
            description: '并发数量，默认 3'
          },
          size: {
            type: 'string',
            description: '图像尺寸，默认 1280x1280。推荐枚举值：1280x1280(默认), 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728',
            enum: ['1280x1280', '1568x1056', '1056x1568', '1472x1088', '1088x1472', '1728x960', '960x1728', '1024x1024', '768x1024', '1024x768'],
            default: '1280x1280'
          }
        },
        required: ['requests']
      }
    },
    {
      name: 'generate_image_batch',
      description: '批量生成多张图像，支持并发执行。🎨 提示词请用中文书写，适合需要生成多个创意作品的场景。可选择使用 nano-banana-pro (Google) 或 seedream-4.5 (ByteDance) 模型。nano-banana-pro 默认 2K 分辨率，支持 1K/2K/4K。',
      inputSchema: {
        type: 'object',
        properties: {
          requests: {
            type: 'array',
            description: '批量生成请求列表，每项包含创意描述（中文）和可选的保存路径',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '图像生成的创意描述（中文）' },
                saveToFilePath: { type: 'string', description: '可选的保存路径' }
              },
              required: ['prompt']
            }
          },
          concurrency: {
            type: 'number',
            description: '并发数量，默认 3'
          },
          model: {
            type: 'string',
            description: '使用的模型：nano-banana-pro (Google高质量) 或 seedream-4.5 (ByteDance快速)，默认 nano-banana-pro',
            enum: ['nano-banana-pro', 'seedream-4.5']
          },
          image_size: {
            type: 'string',
            description: '图像分辨率（仅 nano-banana-pro 支持）：1K（标准）、2K（高清，默认）、4K（超高清）',
            enum: ['1K', '2K', '4K'],
            default: '2K'
          },
          aspect_ratio: {
            type: 'string',
            description: '宽高比（仅 nano-banana-pro 支持），如 1:1、16:9、9:16 等',
            enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
          }
        },
        required: ['requests']
      }
    },
    {
      name: 'images_to_pdf',
      description: '将多张图片转换为 PDF 文件。📄 每页一张图片，页面尺寸完全匹配图片比例，无空白，完美填充。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePaths: {
            type: 'array',
            description: '图片文件路径列表，按顺序排列',
            items: { type: 'string' }
          },
          outputPath: {
            type: 'string',
            description: 'PDF 输出文件路径（包含 .pdf 扩展名）'
          }
        },
        required: ['imagePaths', 'outputPath']
      }
    },
    {
      name: 'images_to_pptx',
      description: '将多张图片转换为 PowerPoint (PPTX) 文件。📊 每张幻灯片一张图片，图片填满整个幻灯片，适合演示展示。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePaths: {
            type: 'array',
            description: '图片文件路径列表，按顺序排列',
            items: { type: 'string' }
          },
          outputPath: {
            type: 'string',
            description: 'PPTX 输出文件路径（包含 .pptx 扩展名）'
          }
        },
        required: ['imagePaths', 'outputPath']
      }
    }
  ];

  const response = { tools };
  console.error('发送工具列表响应:', JSON.stringify(response, null, 2));
  return response;
});

// 注册工具调用处理器
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'generate_image_nano': {
        const { prompt, saveToFilePath, image_size, aspect_ratio } = args;
        
        if (!prompt) {
          throw new Error('缺少必需的参数: prompt');
        }

        // 构建 image_config，默认 2K
        const imageConfig = { image_size: image_size || '2K' };
        if (aspect_ratio) imageConfig.aspect_ratio = aspect_ratio;

        const result = await generateImage(prompt, saveToFilePath, API_CONFIG.modelNanoBanana, imageConfig);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'generate_image_seedream': {
        const { prompt, saveToFilePath } = args;
        
        if (!prompt) {
          throw new Error('缺少必需的参数: prompt');
        }

        const result = await generateImage(prompt, saveToFilePath, API_CONFIG.modelSeedream);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'edit_image_nano': {
        const { imagePath, editPrompt, saveToFilePath, image_size, aspect_ratio } = args;
        
        if (!imagePath || !editPrompt) {
          throw new Error('缺少必需的参数: imagePath 或 editPrompt');
        }

        // 构建 image_config，默认 2K
        const imageConfig = { image_size: image_size || '2K' };
        if (aspect_ratio) imageConfig.aspect_ratio = aspect_ratio;

        const result = await editImage(imagePath, editPrompt, saveToFilePath, API_CONFIG.modelNanoBanana, imageConfig);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'edit_image_seedream': {
        const { imagePath, editPrompt, saveToFilePath } = args;
        
        if (!imagePath || !editPrompt) {
          throw new Error('缺少必需的参数: imagePath 或 editPrompt');
        }

        const result = await editImage(imagePath, editPrompt, saveToFilePath, API_CONFIG.modelSeedream);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'generate_image_batch': {
        const { requests, concurrency, model, image_size, aspect_ratio } = args;
        if (!requests || !Array.isArray(requests) || requests.length === 0) {
          throw new Error('缺少必需的参数: requests (数组)');
        }

        const selectedModel = model === 'seedream-4.5' ? API_CONFIG.modelSeedream : API_CONFIG.modelNanoBanana;
        
        // 构建 image_config（仅 nano-banana-pro 支持），默认 2K
        let imageConfig = null;
        if (selectedModel === API_CONFIG.modelNanoBanana) {
          imageConfig = { image_size: image_size || '2K' };
          if (aspect_ratio) imageConfig.aspect_ratio = aspect_ratio;
        }
        
        const results = await generateImageBatch(requests, concurrency || 3, selectedModel, imageConfig);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: results.every(r => r.success),
                results
              }, null, 2)
            }
          ]
        };
      }

      case 'generate_image_glm': {
        const { prompt, saveToFilePath, size } = args;
        
        if (!prompt) {
          throw new Error('缺少必需的参数: prompt');
        }

        const result = await generateImageGlm(prompt, saveToFilePath, size || '1280x1280');
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'generate_image_glm_batch': {
        const { requests, concurrency, size } = args;
        if (!requests || !Array.isArray(requests) || requests.length === 0) {
          throw new Error('缺少必需的参数: requests (数组)');
        }

        const results = await generateImageGlmBatch(requests, concurrency || 3, size || '1280x1280');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: results.every(r => r.success),
                results
              }, null, 2)
            }
          ]
        };
      }

      case 'images_to_pdf': {
        const { imagePaths, outputPath } = args;
        
        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) {
          throw new Error('缺少必需的参数: imagePaths (图片路径数组)');
        }
        if (!outputPath) {
          throw new Error('缺少必需的参数: outputPath (PDF 输出路径)');
        }

        const result = await imagesToPdf(imagePaths, outputPath);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'images_to_pptx': {
        const { imagePaths, outputPath } = args;
        
        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) {
          throw new Error('缺少必需的参数: imagePaths (图片路径数组)');
        }
        if (!outputPath) {
          throw new Error('缺少必需的参数: outputPath (PPTX 输出路径)');
        }

        const result = await imagesToPptx(imagePaths, outputPath);
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    console.error(`工具 ${name} 执行失败:`, error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            tool: name
          }, null, 2)
        }
      ],
      isError: true
    };
  }
});

// 启动服务器
async function main() {
  try {
    console.error('启动自定义 Gemini MCP 服务器...');
    console.error(`Node.js 版本: ${process.version}`);
    console.error(`工作目录: ${process.cwd()}`);
    console.error(`API 配置: ${JSON.stringify({
      apiBase: API_CONFIG.apiBase,
      modelNanoBanana: API_CONFIG.modelNanoBanana,
      modelGeminiFlash: API_CONFIG.modelGeminiFlash,
      outputDir: API_CONFIG.outputDir,
      hasApiKey: !!API_CONFIG.apiKey
    }, null, 2)}`);

    await ensureOutputDir();
    console.error('输出目录已确保存在');

    const transport = new StdioServerTransport();
    console.error('创建 STDIO 传输层');

    await server.connect(transport);
    console.error('自定义 Gemini MCP 服务器已启动并连接');

    // 添加进程退出处理
    process.on('SIGINT', () => {
      console.error('收到 SIGINT，正在关闭服务器...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error('收到 SIGTERM，正在关闭服务器...');
      process.exit(0);
    });

  } catch (error) {
    console.error('启动过程中发生错误:', error);
    console.error('错误堆栈:', error.stack);
    throw error;
  }
}

main().catch((error) => {
  console.error('启动服务器失败:', error);
  console.error('错误详情:', error.stack);
  process.exit(1);
});
