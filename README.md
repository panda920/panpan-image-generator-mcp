<p align="center">
  <img src="assets/banner.png" alt="PanPan Image Generator" width="100%">
</p>

<h1 align="center">PanPan Image Generator MCP</h1>

<p align="center">
  <strong>AI-powered image generation & editing MCP server for Claude Code</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#supported-models">Models</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#tools">Tools</a> •
  <a href="#examples">Examples</a>
</p>

---

## Features

- **Multi-model support** — Gemini Pro Image Preview (1K/2K/4K) and Gemini Flash Image Preview
- **Image editing** — Edit existing images with text instructions, supports multi-image reference
- **Batch generation** — High-concurrency worker pool for parallel image generation
- **Shared context** — Generate series of images with consistent style (great for slides, tutorials, card sets)
- **Resolution control** — 1K / 2K / 4K presets or custom WxH, plus aspect ratio selection
- **Format conversion** — Convert images to PDF or PowerPoint (PPTX)
- **Smart file handling** — Auto-fallback output directory, customizable per-request save paths

---

## Supported Models

| Model ID | Alias | Quality |
|----------|-------|---------|
| `gemini-3-pro-image-preview` | `nanobananapro` | High quality, 1K |
| `gemini-3-pro-image-preview-2k` | — | High quality, 2K |
| `gemini-3-pro-image-preview-4k` | — | High quality, 4K |
| `gemini-3.1-flash-image-preview` | `nanobanana2`, `gemini-flash` | Fast |

All models are accessed through any OpenAI-compatible API endpoint that supports Gemini image generation.

---

## Demo

<table>
  <tr>
    <td align="center">
      <img src="assets/demo-art.png" width="300"><br>
      <sub>Art illustration</sub>
    </td>
    <td align="center">
      <img src="assets/demo-cyberpunk.png" width="300"><br>
      <sub>Cyberpunk</sub>
    </td>
    <td align="center">
      <img src="assets/demo-chinese.png" width="300"><br>
      <sub>Chinese ink painting</sub>
    </td>
  </tr>
</table>

---

## Quick Start

### Install

```bash
git clone https://github.com/panda920/panpan-image-generator-mcp.git
cd panpan-image-generator-mcp
npm install
```

### Configure

Copy the example env file and fill in your API key:

```bash
cp .env.example .env
```

Edit `.env`:

```env
GEMINI_API_KEY=your_api_key_here
GEMINI_API_BASE=https://openrouter.ai/api/v1
```

### Use with Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "panpan-image-generator": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/panpan-image-generator-mcp/panpan-image-generator-mcp-server.js"],
      "env": {
        "GEMINI_API_KEY": "your_api_key",
        "GEMINI_API_BASE": "https://openrouter.ai/api/v1"
      }
    }
  }
}
```

---

## Tools

### Image Generation

| Tool | Description |
|------|-------------|
| `generate_image_batch` | Generate one or more images with high concurrency. Supports all 4 models, custom resolution and aspect ratio. |
| `generate_image_with_shared_context` | Batch generate images with shared style context for visual consistency. Ideal for slides, tutorials, card sets. |

### Image Editing

| Tool | Description |
|------|-------------|
| `edit_image_nano` | Edit images (single or batch). Supports all 4 models, multi-image reference, custom resolution and aspect ratio. |

### Format Conversion

| Tool | Description |
|------|-------------|
| `images_to_pdf` | Convert multiple images to a PDF document (one image per page, full bleed). |
| `images_to_pptx` | Convert multiple images to a PowerPoint presentation. |

---

## Examples

In Claude Code, just ask naturally:

```
Generate a cyberpunk cityscape at night in 4K

Edit this image: change the background to blue

Batch generate 5 cat illustrations in different styles

Create a 10-slide presentation with consistent branding, then export to PPTX
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | API key (required) |
| `GEMINI_API_BASE` | `https://openrouter.ai/api/v1` | OpenAI-compatible API base URL |
| `GEMINI_MODEL` | `gemini-3-pro-image-preview` | Default Pro model |
| `GEMINI_FLASH_MODEL` | `gemini-3.1-flash-image-preview` | Default Flash model |
| `OUTPUT_DIR` | Current working directory | Default output directory |

---

## Requirements

- Node.js >= 18.0.0

---

## License

MIT License

---

<p align="center">
  Made with ❤️ by PanPan
</p>
