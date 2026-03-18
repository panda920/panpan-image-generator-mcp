#!/usr/bin/env node

/**
 * 自定义 Gemini MCP 服务器
 * 支持使用第三方 API 进行图像生成
 * 支持模型：
 *   - gemini-3-pro-image-preview      (nanobananapro，高质量)
 *   - gemini-3-pro-image-preview-2k   (Pro 2K)
 *   - gemini-3-pro-image-preview-4k   (Pro 4K)
 *   - gemini-3.1-flash-image-preview  (nanobanana2，快速)
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

// ─── 模型注册表 ──────────────────────────────────────────────────────────────
// key = 工具参数中使用的别名，value = 实际 API model id
const MODEL_REGISTRY = {
  'nanobananapro':              'gemini-3-pro-image-preview',
  'nano-banana-pro':            'gemini-3-pro-image-preview',
  'gemini-3-pro':               'gemini-3-pro-image-preview',
  'gemini-3-pro-image-preview': 'gemini-3-pro-image-preview',

  'gemini-3-pro-2k':                'gemini-3-pro-image-preview-2k',
  'gemini-3-pro-image-preview-2k':  'gemini-3-pro-image-preview-2k',

  'gemini-3-pro-4k':                'gemini-3-pro-image-preview-4k',
  'gemini-3-pro-image-preview-4k':  'gemini-3-pro-image-preview-4k',

  'nanobanana2':                        'gemini-3.1-flash-image-preview',
  'gemini-flash':                       'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash':                   'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-image-preview':     'gemini-3.1-flash-image-preview',
};

// 分辨率映射：image_size 参数 → prompt 中注入的分辨率描述
const RESOLUTION_MAP = {
  '1K':  '1024x576',
  '2K':  '2048x1152',
  '4K':  '3840x2160',
  // 也支持直接传 WxH 格式，如 "1920x1080"
};

// 默认模型（可通过环境变量覆盖）
const DEFAULT_MODEL_KEY = process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview';
const DEFAULT_FLASH_KEY = process.env.GEMINI_FLASH_MODEL || 'gemini-3.1-flash-image-preview';

// ─── API 配置 ─────────────────────────────────────────────────────────────────
const API_BASE_RAW = process.env.GEMINI_API_BASE || 'https://openrouter.ai/api/v1';
const API_BASE = API_BASE_RAW.replace(/\/$/, ''); // 去掉末尾斜杠
const CHAT_API_URL = API_BASE.endsWith('/v1')
  ? `${API_BASE}/chat/completions`
  : `${API_BASE}/v1/chat/completions`;

const API_CONFIG = {
  apiKey:           process.env.GEMINI_API_KEY || '',
  apiBase:          API_BASE,
  chatApiUrl:       CHAT_API_URL,
  modelNanoBanana:  resolveModel(DEFAULT_MODEL_KEY),
  modelGeminiFlash: resolveModel(DEFAULT_FLASH_KEY),
  // 默认输出目录：优先用环境变量，否则用当前工作目录（即调用方的项目目录）
  outputDir:        process.env.OUTPUT_DIR || process.cwd(),
  // MCP 服务器自身目录，作为写入失败时的 fallback
  fallbackDir:      path.join(__dirname, 'generated-images'),
};

/** 将别名/model id 解析为实际 API model id */
function resolveModel(nameOrAlias) {
  return MODEL_REGISTRY[nameOrAlias] || nameOrAlias;
}

/** 根据 image_size / resolution 参数构建分辨率描述字符串 */
function buildResolutionHint(imageConfig) {
  if (!imageConfig) return null;
  const { image_size, resolution } = imageConfig;

  // 优先使用 resolution（直接 WxH）
  if (resolution && /^\d+x\d+$/i.test(resolution)) return resolution;

  // 其次使用 image_size 枚举
  if (image_size && RESOLUTION_MAP[image_size]) return RESOLUTION_MAP[image_size];

  return null;
}

/** 将分辨率和宽高比信息注入 prompt */
function buildEnhancedPrompt(prompt, imageConfig) {
  if (!imageConfig) return prompt;

  const parts = [];
  const resHint = buildResolutionHint(imageConfig);
  if (resHint) parts.push(`Resolution: ${resHint}`);
  if (imageConfig.aspect_ratio) parts.push(`Aspect ratio: ${imageConfig.aspect_ratio}`);

  if (parts.length === 0) return prompt;
  return `[${parts.join(', ')}] ${prompt}`;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

async function ensureDir(dir) {
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function ensureOutputDir() {
  await ensureDir(API_CONFIG.outputDir);
}

/** 生成默认文件名（不含目录） */
function buildFilename(prompt) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safePrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  return `generated_${safePrompt}_${ts}.png`;
}

/**
 * 将图片 buffer 写入文件，失败时自动 fallback 到 MCP 服务器目录。
 * 返回最终写入的路径。
 */
async function saveImageBuffer(imageBuffer, saveToFilePath, prompt) {
  // 有明确路径时直接写
  if (saveToFilePath) {
    const dir = path.dirname(saveToFilePath);
    await ensureDir(dir);
    await fs.writeFile(saveToFilePath, imageBuffer);
    console.error(`[saveImage] 已保存到指定路径: ${saveToFilePath}`);
    return saveToFilePath;
  }

  // 没有路径：尝试写入 outputDir（默认 = 当前工作目录）
  const filename = buildFilename(prompt);
  const primaryPath = path.join(API_CONFIG.outputDir, filename);
  try {
    await ensureDir(API_CONFIG.outputDir);
    await fs.writeFile(primaryPath, imageBuffer);
    console.error(`[saveImage] 已保存到默认目录: ${primaryPath}`);
    return primaryPath;
  } catch (err) {
    // fallback：写入 MCP 服务器目录
    console.error(`[saveImage] 写入默认目录失败 (${err.message})，fallback 到 MCP 目录`);
    const fallbackPath = path.join(API_CONFIG.fallbackDir, filename);
    await ensureDir(API_CONFIG.fallbackDir);
    await fs.writeFile(fallbackPath, imageBuffer);
    console.error(`[saveImage] 已 fallback 保存到: ${fallbackPath}`);
    return fallbackPath;
  }
}

/** 从 OpenAI 兼容 API 响应中提取图像 base64 数据 */
function extractImageFromResponse(responseText) {
  let imageBase64 = null;
  let textContent = '';

  try {
    const jsonData = JSON.parse(responseText);
    if (jsonData.choices && jsonData.choices[0] && jsonData.choices[0].message) {
      const message = jsonData.choices[0].message;
      const messageContent = message.content;

      // message.images 数组
      if (message.images && Array.isArray(message.images)) {
        for (const img of message.images) {
          if (img.type === 'image_url' && img.image_url && img.image_url.url) {
            const m = img.image_url.url.match(/^data:image\/[^;]+;base64,(.+)$/);
            if (m) imageBase64 = m[1];
          }
        }
      }

      if (Array.isArray(messageContent)) {
        for (const part of messageContent) {
          if (part.type === 'text') textContent += part.text || '';
          else if (part.type === 'image' && part.inline_data) imageBase64 = part.inline_data.data;
          else if (part.type === 'image_url' && part.image_url) {
            const m = part.image_url.url.match(/^data:image\/[^;]+;base64,(.+)$/);
            if (m) imageBase64 = m[1];
          }
        }
      } else if (typeof messageContent === 'string') {
        textContent = messageContent;
      }
    }
  } catch (e) {
    console.error(`JSON 解析失败: ${e.message}`);
  }

  // markdown 格式 base64
  if (!imageBase64 && textContent) {
    const m = textContent.match(/!\[.*?\]\((data:image\/[^;]+;base64,([A-Za-z0-9+/=\s]+))\)/s);
    if (m) {
      imageBase64 = m[2].replace(/\s/g, '');
      console.error(`[extractImage] 从 markdown 提取图像，长度: ${imageBase64.length}`);
    }
  }

  // data URI
  if (!imageBase64 && textContent) {
    const m = textContent.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (m) imageBase64 = m[1];
  }

  // 图片 URL
  let imageUrl = null;
  if (!imageBase64 && textContent) {
    const m = textContent.match(/https?:\/\/[^\s)]+\.(jpg|jpeg|png|gif|webp)/i);
    if (m) imageUrl = m[0];
  }

  return { imageBase64, imageUrl, textContent };
}

// ─── 核心生图函数 ─────────────────────────────────────────────────────────────

/**
 * 生成单张图片
 * @param {string} prompt
 * @param {string|null} saveToFilePath
 * @param {string} model  - 可以是别名或实际 model id
 * @param {object|null} imageConfig - { aspect_ratio?, image_size?, resolution? }
 */
async function generateImage(prompt, saveToFilePath = null, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  const resolvedModel = resolveModel(model);
  console.error(`[generateImage] 模型: ${resolvedModel}`);

  const enhancedPrompt = buildEnhancedPrompt(prompt, imageConfig);

  const requestBody = {
    model: resolvedModel,
    messages: [{ role: 'user', content: enhancedPrompt }],
    max_tokens: 4096,
  };

  const response = await fetch(API_CONFIG.chatApiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_CONFIG.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
  }

  const responseText = await response.text();
  const { imageBase64, imageUrl } = extractImageFromResponse(responseText);

  let imageBuffer;
  if (imageBase64) {
    imageBuffer = Buffer.from(imageBase64, 'base64');
  } else if (imageUrl) {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`下载图像失败: ${imgRes.status}`);
    imageBuffer = await imgRes.buffer();
  } else {
    throw new Error('未在响应中找到图像数据，可能需要调整提示词');
  }

  const finalPath = await saveImageBuffer(imageBuffer, saveToFilePath, prompt);
  return { success: true, message: `图像生成成功: ${finalPath}`, filePath: finalPath, prompt };
}

/** 批量生图（高并发 worker pool） */
async function generateImageBatch(batchRequests = [], concurrency = 10, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  if (!Array.isArray(batchRequests) || batchRequests.length === 0) {
    throw new Error('缺少批量请求列表');
  }

  const results = [];
  const queue = batchRequests.slice();

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const { prompt, saveToFilePath } = queue.shift();
      if (!prompt) { results.push({ success: false, error: '缺少 prompt', prompt }); continue; }
      try {
        results.push(await generateImage(prompt, saveToFilePath, model, imageConfig));
      } catch (e) {
        results.push({ success: false, error: e.message, prompt });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** 共享上下文批量生图 */
async function generateImageWithSharedContext(styleContext, batchRequests = [], concurrency = 10, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  if (!Array.isArray(batchRequests) || batchRequests.length === 0) {
    throw new Error('缺少批量请求列表');
  }

  console.error(`[共享上下文] 开始 ${batchRequests.length} 个请求，并发: ${concurrency}`);

  const results = [];
  const queue = batchRequests.slice();

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const request = queue.shift();
      const { prompt, saveToFilePath, pageNumber } = request;
      if (!prompt) { results.push({ success: false, error: '缺少 prompt', prompt, pageNumber }); continue; }

      const enhancedPrompt = styleContext
        ? `${styleContext}\n\n---\n\n【当前页面】第 ${pageNumber || '?'} 页\n${prompt}`
        : prompt;

      try {
        const result = await generateImage(enhancedPrompt, saveToFilePath, model, imageConfig);
        results.push({ ...result, pageNumber });
      } catch (e) {
        results.push({ success: false, error: e.message, prompt, pageNumber });
      }
    }
  });

  await Promise.all(workers);
  results.sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0));
  return results;
}

/** 图像编辑（支持多图参考） */
async function editImage(imagePath, editPrompt, saveToFilePath = null, model = API_CONFIG.modelNanoBanana, imageConfig = null, referenceImages = []) {
  const resolvedModel = resolveModel(model);
  console.error(`[editImage] 模型: ${resolvedModel}`);

  const imageBuffer = await fs.readFile(imagePath);
  const metadata = await sharp(imageBuffer).metadata();
  const originalRatio = metadata.width / metadata.height;

  // 自动检测宽高比
  const standardRatios = [
    { ratio: 1, name: '1:1' }, { ratio: 2/3, name: '2:3' }, { ratio: 3/2, name: '3:2' },
    { ratio: 3/4, name: '3:4' }, { ratio: 4/3, name: '4:3' }, { ratio: 4/5, name: '4:5' },
    { ratio: 5/4, name: '5:4' }, { ratio: 9/16, name: '9:16' }, { ratio: 16/9, name: '16:9' },
    { ratio: 21/9, name: '21:9' }
  ];
  let closestRatio = standardRatios.reduce((best, sr) =>
    Math.abs(originalRatio - sr.ratio) < Math.abs(originalRatio - best.ratio) ? sr : best
  );

  if (!imageConfig) imageConfig = {};
  if (!imageConfig.aspect_ratio) imageConfig.aspect_ratio = closestRatio.name;

  const enhancedPrompt = buildEnhancedPrompt(`${editPrompt}\n\n保持原图其他所有元素不变。`, imageConfig);

  const contentArray = [
    { type: 'text', text: enhancedPrompt },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` } }
  ];

  for (const refPath of referenceImages) {
    try {
      const refBuf = await fs.readFile(refPath);
      contentArray.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${refBuf.toString('base64')}` } });
    } catch (err) {
      console.error(`读取参考图失败: ${refPath} - ${err.message}`);
    }
  }

  const response = await fetch(API_CONFIG.chatApiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_CONFIG.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: resolvedModel, messages: [{ role: 'user', content: contentArray }], max_tokens: 4096 }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API 请求失败: ${response.status} - ${errorText}`);
  }

  const responseText = await response.text();
  const { imageBase64, imageUrl } = extractImageFromResponse(responseText);

  let editedBuffer;
  if (imageBase64) {
    editedBuffer = Buffer.from(imageBase64, 'base64');
  } else if (imageUrl) {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`下载图像失败: ${imgRes.status}`);
    editedBuffer = await imgRes.buffer();
  } else {
    throw new Error('未在编辑响应中找到图像数据');
  }

  // 编辑图片默认文件名加 edited_ 前缀
  let editSavePath = saveToFilePath;
  if (!editSavePath) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safePrompt = editPrompt.substring(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    editSavePath = `edited_${safePrompt}_${ts}.png`;
    // 传 null 让 saveImageBuffer 自动拼目录，但我们需要带前缀的文件名
    // 所以先构造完整路径再传入
    editSavePath = path.join(API_CONFIG.outputDir, editSavePath);
  }

  const finalPath = await saveImageBuffer(editedBuffer, editSavePath, editPrompt);
  return { success: true, message: `图像编辑成功: ${finalPath}`, filePath: finalPath, originalPath: imagePath, editPrompt };
}

/** 批量编辑图像 */
async function editImageBatch(batchRequests = [], concurrency = 10, model = API_CONFIG.modelNanoBanana, imageConfig = null) {
  if (!Array.isArray(batchRequests) || batchRequests.length === 0) {
    throw new Error('缺少批量请求列表');
  }

  const results = [];
  const queue = batchRequests.slice();

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const req = queue.shift();
      const { imagePath, editPrompt, saveToFilePath, referenceImages } = req;
      if (!imagePath || !editPrompt) { results.push({ success: false, error: '缺少 imagePath 或 editPrompt', req }); continue; }
      try {
        results.push(await editImage(imagePath, editPrompt, saveToFilePath, model, imageConfig, referenceImages || []));
      } catch (e) {
        results.push({ success: false, error: e.message, imagePath, editPrompt });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── PDF / PPTX ───────────────────────────────────────────────────────────────

async function imagesToPdf(imagePaths, outputPath, options = {}) {
  const { maxWidth = 1920, maxHeight = 1080 } = options;
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const { createWriteStream } = await import('fs');
  const writeStream = createWriteStream(outputPath);
  doc.pipe(writeStream);

  for (let i = 0; i < imagePaths.length; i++) {
    const buf = await fs.readFile(imagePaths[i]);
    const meta = await sharp(buf).metadata();
    let w = meta.width, h = meta.height;
    if (w > maxWidth || h > maxHeight) {
      const scale = Math.min(maxWidth / w, maxHeight / h);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    doc.addPage({ size: [w, h], margin: 0 });
    doc.image(buf, 0, 0, { width: w, height: h });
  }

  doc.end();
  await new Promise((resolve, reject) => { writeStream.on('finish', resolve); writeStream.on('error', reject); });
  return { success: true, message: `PDF 已保存: ${outputPath}`, filePath: outputPath, pageCount: imagePaths.length };
}

async function imagesToPptx(imagePaths, outputPath) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.author = 'PanPan Image Generator';
  pptx.title = 'Generated Presentation';

  for (let i = 0; i < imagePaths.length; i++) {
    const buf = await fs.readFile(imagePaths[i]);
    const meta = await sharp(buf).metadata();
    const imgAspect = meta.width / meta.height;

    if (imgAspect > 1.5) pptx.defineLayout({ name: 'CUSTOM', width: 13.33, height: 7.5 });
    else if (imgAspect < 0.67) pptx.defineLayout({ name: 'CUSTOM', width: 7.5, height: 13.33 });
    else pptx.defineLayout({ name: 'CUSTOM', width: 10, height: 7.5 });
    pptx.layout = 'CUSTOM';

    const slide = pptx.addSlide();
    const ext = path.extname(imagePaths[i]).toLowerCase().replace('.', '') || 'png';
    slide.addImage({
      data: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`,
      x: 0, y: 0, w: '100%', h: '100%',
      sizing: { type: 'cover', w: '100%', h: '100%' }
    });
  }

  await pptx.writeFile({ fileName: outputPath });
  return { success: true, message: `PPTX 已保存: ${outputPath}`, filePath: outputPath, slideCount: imagePaths.length };
}

// ─── MCP 服务器 ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'panpan-image-generator-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(InitializeRequestSchema, async () => ({
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'panpan-image-generator-mcp', version: '2.0.0' },
}));

server.setNotificationHandler(InitializedNotificationSchema, async () => {
  console.error('MCP 服务器初始化完成');
});

// ─── 工具定义 ─────────────────────────────────────────────────────────────────

const MODEL_ENUM = [
  'nanobananapro',
  'nano-banana-pro',
  'gemini-3-pro-image-preview',
  'gemini-3-pro-image-preview-2k',
  'gemini-3-pro-image-preview-4k',
  'nanobanana2',
  'gemini-flash',
  'gemini-3.1-flash-image-preview',
];

const IMAGE_SIZE_ENUM = ['1K', '2K', '4K'];
const ASPECT_RATIO_ENUM = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const RESOLUTION_PROPS = {
  image_size: {
    type: 'string',
    description: '图像分辨率预设：1K(1024x576)、2K(2048x1152，默认)、4K(3840x2160)',
    enum: IMAGE_SIZE_ENUM,
    default: '2K',
  },
  resolution: {
    type: 'string',
    description: '自定义分辨率，格式 WxH，如 1920x1080。优先级高于 image_size。',
  },
  aspect_ratio: {
    type: 'string',
    description: '宽高比',
    enum: ASPECT_RATIO_ENUM,
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'edit_image_nano',
      description: '编辑图像（单张或批量）。支持全部四款生图模型，支持多图参考，支持指定分辨率和宽高比。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePath: { type: 'string', description: '【单张】要编辑的图像路径' },
          editPrompt: { type: 'string', description: '【单张】编辑指令' },
          requests: {
            type: 'array',
            description: '【批量】批量编辑请求列表',
            items: {
              type: 'object',
              properties: {
                imagePath: { type: 'string' },
                editPrompt: { type: 'string' },
                saveToFilePath: { type: 'string' },
                referenceImages: { type: 'array', items: { type: 'string' } },
              },
              required: ['imagePath', 'editPrompt'],
            },
          },
          concurrency: { type: 'number', description: '并发数，默认 10' },
          referenceImages: { type: 'array', description: '【单张】参考图片路径数组', items: { type: 'string' } },
          saveToFilePath: { type: 'string', description: '保存路径' },
          model: { type: 'string', description: '模型选择，默认 nanobananapro', enum: MODEL_ENUM },
          ...RESOLUTION_PROPS,
        },
      },
    },
    {
      name: 'generate_image_with_shared_context',
      description: '🎯【推荐】共享上下文批量生图（保持风格一致性）。适合 PPT、教程、卡片组等系列图片。支持全部四款模型，支持指定分辨率。',
      inputSchema: {
        type: 'object',
        properties: {
          styleContext: {
            type: 'string',
            description: '【必填】全局风格上下文（系列名称、背景色、强调色、排版规范等）',
          },
          requests: {
            type: 'array',
            description: '批量生成请求列表',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                pageNumber: { type: 'number' },
                saveToFilePath: { type: 'string' },
              },
              required: ['prompt', 'pageNumber'],
            },
          },
          concurrency: { type: 'number', description: '并发数，默认 10' },
          model: { type: 'string', description: '模型选择，默认 nanobananapro', enum: MODEL_ENUM },
          ...RESOLUTION_PROPS,
        },
        required: ['styleContext', 'requests'],
      },
    },
    {
      name: 'generate_image_batch',
      description: '批量生图（单张或多张，高并发）。支持全部四款模型：nanobananapro / gemini-3-pro-image-preview（高质量）、gemini-3-pro-image-preview-2k（2K）、gemini-3-pro-image-preview-4k（4K）、nanobanana2 / gemini-flash（快速）。支持指定分辨率和宽高比。\n\n📁 路径规则：① 每条请求可单独指定 saveToFilePath；② 可用 outputDir 统一指定目录（默认当前工作目录）；③ 写入失败时自动 fallback 到 MCP 服务器目录。',
      inputSchema: {
        type: 'object',
        properties: {
          requests: {
            type: 'array',
            description: '生成请求列表',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: '图像描述（中文）' },
                saveToFilePath: { type: 'string', description: '可选，指定完整保存路径（含文件名）' },
              },
              required: ['prompt'],
            },
          },
          outputDir: {
            type: 'string',
            description: '可选，统一指定输出目录（不含文件名）。未指定时默认为当前工作目录。单条请求的 saveToFilePath 优先级更高。',
          },
          concurrency: { type: 'number', description: '并发数，默认 10' },
          model: {
            type: 'string',
            description: '模型选择：nanobananapro（高质量，默认）、gemini-3-pro-image-preview-2k（Pro 2K）、gemini-3-pro-image-preview-4k（Pro 4K）、nanobanana2（快速）',
            enum: MODEL_ENUM,
          },
          ...RESOLUTION_PROPS,
        },
        required: ['requests'],
      },
    },
    {
      name: 'images_to_pdf',
      description: '将多张图片转换为 PDF（每页一张，完美填充无空白）。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePaths: { type: 'array', items: { type: 'string' } },
          outputPath: { type: 'string' },
        },
        required: ['imagePaths', 'outputPath'],
      },
    },
    {
      name: 'images_to_pptx',
      description: '将多张图片转换为 PowerPoint (PPTX) 文件。',
      inputSchema: {
        type: 'object',
        properties: {
          imagePaths: { type: 'array', items: { type: 'string' } },
          outputPath: { type: 'string' },
        },
        required: ['imagePaths', 'outputPath'],
      },
    },
  ],
}));

// ─── 工具调用处理 ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'edit_image_nano': {
        const { imagePath, editPrompt, saveToFilePath, image_size, resolution, aspect_ratio, referenceImages, requests, concurrency, model, outputDir } = args;
        const selectedModel = resolveModel(model || API_CONFIG.modelNanoBanana);
        const imageConfig = { image_size: image_size || '2K', resolution, aspect_ratio };

        const prevOutputDir = API_CONFIG.outputDir;
        if (outputDir) {
          API_CONFIG.outputDir = outputDir;
          console.error(`[edit_image_nano] outputDir 覆盖为: ${outputDir}`);
        }

        let editResult;
        try {
          if (requests && Array.isArray(requests) && requests.length > 0) {
            const results = await editImageBatch(requests, concurrency || 10, selectedModel, imageConfig);
            editResult = { content: [{ type: 'text', text: JSON.stringify({ success: results.every(r => r.success), results }, null, 2) }] };
          } else {
            if (!imagePath || !editPrompt) throw new Error('缺少 imagePath 或 editPrompt');
            const result = await editImage(imagePath, editPrompt, saveToFilePath, selectedModel, imageConfig, referenceImages || []);
            editResult = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }
        } finally {
          API_CONFIG.outputDir = prevOutputDir;
        }
        return editResult;
      }

      case 'generate_image_with_shared_context': {
        const { styleContext, requests, concurrency, image_size, resolution, aspect_ratio, model, outputDir } = args;
        if (!styleContext) throw new Error('缺少 styleContext');
        if (!requests || !Array.isArray(requests) || requests.length === 0) throw new Error('缺少 requests');

        const selectedModel = resolveModel(model || API_CONFIG.modelNanoBanana);
        const imageConfig = { image_size: image_size || '2K', resolution, aspect_ratio };

        const prevOutputDir = API_CONFIG.outputDir;
        if (outputDir) {
          API_CONFIG.outputDir = outputDir;
          console.error(`[shared_context] outputDir 覆盖为: ${outputDir}`);
        }

        let results;
        try {
          results = await generateImageWithSharedContext(styleContext, requests, concurrency || 10, selectedModel, imageConfig);
        } finally {
          API_CONFIG.outputDir = prevOutputDir;
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: results.every(r => r.success),
              totalPages: requests.length,
              successCount: results.filter(r => r.success).length,
              failedCount: results.filter(r => !r.success).length,
              results,
            }, null, 2),
          }],
        };
      }

      case 'generate_image_batch': {
        const { requests, concurrency, model, image_size, resolution, aspect_ratio, outputDir } = args;
        if (!requests || !Array.isArray(requests) || requests.length === 0) throw new Error('缺少 requests');

        const selectedModel = resolveModel(model || API_CONFIG.modelNanoBanana);
        const imageConfig = { image_size: image_size || '2K', resolution, aspect_ratio };

        // 若传了 outputDir，临时覆盖 API_CONFIG.outputDir（仅本次调用）
        const prevOutputDir = API_CONFIG.outputDir;
        if (outputDir) {
          API_CONFIG.outputDir = outputDir;
          console.error(`[generate_image_batch] outputDir 覆盖为: ${outputDir}`);
        }

        let results;
        try {
          results = await generateImageBatch(requests, concurrency || 10, selectedModel, imageConfig);
        } finally {
          API_CONFIG.outputDir = prevOutputDir;
        }

        return { content: [{ type: 'text', text: JSON.stringify({ success: results.every(r => r.success), results }, null, 2) }] };
      }

      case 'images_to_pdf': {
        const { imagePaths, outputPath } = args;
        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) throw new Error('缺少 imagePaths');
        if (!outputPath) throw new Error('缺少 outputPath');
        return { content: [{ type: 'text', text: JSON.stringify(await imagesToPdf(imagePaths, outputPath), null, 2) }] };
      }

      case 'images_to_pptx': {
        const { imagePaths, outputPath } = args;
        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) throw new Error('缺少 imagePaths');
        if (!outputPath) throw new Error('缺少 outputPath');
        return { content: [{ type: 'text', text: JSON.stringify(await imagesToPptx(imagePaths, outputPath), null, 2) }] };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (error) {
    console.error(`工具 ${name} 执行失败:`, error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message, tool: name }, null, 2) }],
      isError: true,
    };
  }
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.error('启动 PanPan Image Generator MCP v2.0...');
  console.error(`Node.js: ${process.version}`);
  console.error(`API Base: ${API_CONFIG.apiBase}`);
  console.error(`Chat URL: ${API_CONFIG.chatApiUrl}`);
  console.error(`默认模型 (Pro): ${API_CONFIG.modelNanoBanana}`);
  console.error(`默认模型 (Flash): ${API_CONFIG.modelGeminiFlash}`);
  console.error(`API Key 已设置: ${!!API_CONFIG.apiKey}`);

  await ensureOutputDir();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP 服务器已启动');

  process.on('SIGINT', () => { console.error('收到 SIGINT，关闭...'); process.exit(0); });
  process.on('SIGTERM', () => { console.error('收到 SIGTERM，关闭...'); process.exit(0); });
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
