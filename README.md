# panpan-image-generator-mcp

MCP (Model Context Protocol) 服务器，支持多种 AI 图像生成模型。

## 支持的模型

- **Nano Banana Pro** (Google Gemini): 高质量图像生成，支持 1K/2K/4K 分辨率
- **Seedream 4.5** (ByteDance): 快速图像生成
- **GLM-Image** (智谱): 中文优化的图像生成

## 功能特性

- 图像生成（支持多种模型和分辨率）
- 图像编辑（基于已有图像进行修改）
- 批量生成
- 图片转 PDF
- 图片转 PPTX

## 安装

```bash
git clone https://github.com/panpanzhilin/panpan-image-generator-mcp.git
cd panpan-image-generator-mcp
npm install
```

## 配置

复制 `.env.example` 为 `.env` 并填入你的 API Key：

```bash
cp .env.example .env
```

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `GEMINI_API_KEY` | OpenRouter API Key | 是（使用 Gemini/Seedream 时） |
| `GEMINI_API_BASE` | API 基础 URL | 否（默认 OpenRouter） |
| `GEMINI_MODEL` | 默认模型 | 否 |
| `ZHIPU_API_KEY` | 智谱 API Key | 是（使用 GLM-Image 时） |

## 在 Claude Code 中使用

在 `~/.claude.json` 中添加以下配置：

```json
{
  "mcpServers": {
    "panpan-image-generator": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/panpan-image-generator-mcp/panpan-image-generator-mcp-server.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key",
        "GEMINI_API_BASE": "https://openrouter.ai/api/v1",
        "ZHIPU_API_KEY": "your_zhipu_api_key"
      }
    }
  }
}
```

## 可用工具

- `generate_image_nano` - 使用 Nano Banana Pro 生成图像
- `generate_image_seedream` - 使用 Seedream 4.5 生成图像
- `generate_image_glm` - 使用 GLM-Image 生成图像
- `edit_image_nano` - 使用 Nano Banana Pro 编辑图像
- `edit_image_seedream` - 使用 Seedream 4.5 编辑图像
- `generate_image_batch` - 批量生成图像
- `generate_image_glm_batch` - 批量生成 GLM 图像
- `images_to_pdf` - 将图片转换为 PDF
- `images_to_pptx` - 将图片转换为 PPTX

## 许可证

MIT
