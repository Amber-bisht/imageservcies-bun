# Bun Image Server (S3-Compatible Direct Presigned Upload)

A lightweight, high-performance image hosting microservice built with **Bun** and **Sharp**. It supports **S3-style Pre-signed URLs**, allowing frontend applications and external websites to securely upload images directly to the server via standard HTTP `PUT` without exposing master API keys.

---

## Features

- **S3-Style Pre-Signed Uploads**: Generate short-lived, tamper-proof HMAC-signed URLs for direct frontend uploads.
- **Client-Selected Formats**: Request either `.webp` (optimized with quality 80) or `.png` at URL generation time.
- **Single-Image & One-Time Use**: Each pre-signed token allows exactly one upload and is immediately invalidated to prevent replay attacks.
- **Sharp Image Processing**: Automatically verifies magic bytes (rejects malicious files / XSS), and resizes large images to max width 1920px while maintaining aspect ratio.
- **CORS Enabled**: Built-in support for preflight `OPTIONS` and cross-origin uploads from external client domains.
- **Secure**: Master API key (`IMAGE_SERVER_SECRET`) is strictly kept on the server; clients only receive scoped, signed upload tokens.
- **Headless & Fast**: Pure JSON API with sub-millisecond response times.

---

## API Reference

### 1. Health Check
Check server and storage status.
- **Endpoint**: `GET /health`
- **Auth**: None
- **Response**:
  ```json
  {
    "status": "ok",
    "service": "bun-image-service",
    "mode": "s3-presigned-direct-upload",
    "timestamp": "2026-08-27T19:30:00.000Z",
    "config": {
      "port": 4000,
      "baseUrl": "http://localhost:4000",
      "secretConfigured": true
    },
    "storage": {
      "path": "/app/public/images",
      "exists": true,
      "writable": true
    }
  }
  ```

---

### 2. Generate Pre-signed Upload URL
Generate a secure, single-use upload URL for frontend direct upload.
- **Endpoint**: `POST /api/presign` (or `POST /presigned-url`)
- **Auth**: Header `x-api-key: YOUR_SECRET_KEY`
- **Body** (JSON):
  ```json
  {
    "format": "webp",          // "webp" or "png" (Required)
    "expiresIn": 300,          // Expiration in seconds (default: 300s / 5 min, max: 3600)
    "maxSizeBytes": 10485760   // Max file size in bytes (default: 10MB)
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "uploadUrl": "http://localhost:4000/upload/direct?fileKey=img-1724803200-ab12cd.webp&expires=1724803500&format=webp&maxSize=10485760&signature=...",
    "method": "PUT",
    "fileKey": "img-1724803200-ab12cd.webp",
    "format": "webp",
    "publicUrl": "http://localhost:4000/images/img-1724803200-ab12cd.webp",
    "expiresAt": 1724803500,
    "expiresInSeconds": 300,
    "maxSizeBytes": 10485760,
    "headersRequired": {
      "Content-Type": "image/*"
    }
  }
  ```

---

### 3. Direct Image Upload (Client / External Website)
Upload a single image file directly to the presigned URL using standard HTTP `PUT`.
- **Endpoint**: `PUT /upload/direct?<signed_query_parameters>`
- **Auth**: HMAC Signature in query parameters (Public, no API key needed)
- **Headers**:
  - `Content-Type`: `image/jpeg`, `image/png`, `image/webp`, etc.
- **Body**: Raw binary image file (`File` / `Blob` / `Buffer`)
- **Response**:
  ```json
  {
    "success": true,
    "url": "http://localhost:4000/images/img-1724803200-ab12cd.webp",
    "fileKey": "img-1724803200-ab12cd.webp",
    "format": "webp",
    "size": 145892,
    "contentType": "image/webp"
  }
  ```

---

### 4. Serve Image
Retrieve a stored image.
- **Endpoint**: `GET /images/:filename`
- **Auth**: None (Public)
- **Response**: Raw image binary with caching headers (`Cache-Control: public, max-age=31536000, immutable`).

---

### 5. List All Images
List all uploaded images sorted by newest first.
- **Endpoint**: `GET /list`
- **Auth**: Header `x-api-key: YOUR_SECRET_KEY`

---

### 6. Delete Image
Delete an image from storage.
- **Endpoint**: `DELETE /images/:filename`
- **Auth**: Header `x-api-key: YOUR_SECRET_KEY`

---

## Frontend Integration Guide

### TypeScript / JavaScript (Vanilla / React / Next.js / Vue)

```typescript
/**
 * Direct Upload Function for Frontend Applications
 * @param file - The File object from <input type="file"> or drag-and-drop
 * @param targetFormat - "webp" (recommended for web) or "png" (for lossless/meta tags)
 * @returns The final public image URL
 */
export async function uploadImageToStorage(
  file: File,
  targetFormat: 'webp' | 'png' = 'webp'
): Promise<string> {
  // Step 1: Request presigned URL from your backend
  // (Your backend calls Bun image server's POST /api/presign using the secret key)
  const presignResponse = await fetch('/api/get-presigned-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format: targetFormat,
      contentType: file.type,
    }),
  });

  if (!presignResponse.ok) {
    throw new Error('Failed to generate upload URL');
  }

  const { uploadUrl, publicUrl } = await presignResponse.json();

  // Step 2: Upload directly to Bun Image Server via HTTP PUT (S3-style)
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type, // e.g. "image/jpeg", "image/png"
    },
    body: file, // Send binary file directly
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    throw new Error(errorData.error || 'Direct upload failed');
  }

  // Step 3: Return public URL ready for display or storing in your DB
  return publicUrl;
}
```

### Backend Example (Node.js / Next.js / Express proxying presign request)

```typescript
// /api/get-presigned-url handler on your application backend
export async function handleGetPresignedUrl(req, res) {
  const { format = 'webp' } = req.body;

  const response = await fetch('http://your-image-server:4000/api/presign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.IMAGE_SERVER_SECRET,
    },
    body: JSON.stringify({
      format, // 'webp' or 'png'
      expiresIn: 300, // 5 minutes
      maxSizeBytes: 10 * 1024 * 1024, // 10MB
    }),
  });

  const data = await response.json();
  return res.status(response.status).json(data);
}
```

---

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4000` | Server listening port |
| `IMAGE_SERVER_SECRET` | *(Required)* | Secret key for API authentication and HMAC signing |
| `BASE_URL` | `http://localhost:4000` | Public URL used to generate public image links |
| `ALLOWED_ORIGIN` | `*` | Allowed CORS origins for external websites |

---

## Running Locally

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create `.env`:
   ```env
   PORT=4000
   IMAGE_SERVER_SECRET=your_super_secret_key
   BASE_URL=http://localhost:4000
   ALLOWED_ORIGIN=*
   ```

3. Run the development server:
   ```bash
   bun run dev
   ```
