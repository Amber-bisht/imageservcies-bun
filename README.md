# Bun Image Server

A high-performance, lightweight image hosting and processing server built with **Bun** and **Sharp**. It automatically converts images to optimized **WebP** formats and manages uploads via a simple API.

## Features
- **Fast Uploads**: Handles multipart/form-data with ease.
- **Auto-Optimization**: Automatically converts images to `.webp` for minimal storage and fast loading.
- **Auto-Resize**: Resizes large images to a maximum width of 1920px while maintaining aspect ratio.
- **Secure**: Protected by API key authentication.
- **Management API**: List, view, and delete images remotely.
- **Dockerized**: Easy deployment using Docker and Docker Compose.
- **CI/CD Ready**: Integrated with GitHub Actions for automated deployment to your VPS.

---

## API Documentation

### 1. Health Check
Check if the server is running.
- **Endpoint**: `GET /health`
- **Auth**: None

### 2. Upload Image
- **Endpoint**: `POST /upload`
- **Auth**: Header `x-api-key: YOUR_SECRET_KEY`
- **Body**: `multipart/form-data` with field `file`
- **Response**:
  ```json
  {
    "success": true,
    "url": "http://your-server.com/images/img-123456.webp",
    "details": { "filename": "...", "mimetype": "image/webp", "size": 1234 }
  }
  ```

### 3. Access Image
- **Endpoint**: `GET /images/:filename`
- **Auth**: None

### 4. List All Images
- **Endpoint**: `GET /list`
- **Auth**: Header `x-api-key: YOUR_SECRET_KEY`

### 5. Delete Image
- **Endpoint**: `DELETE /images/:filename`
- **Auth**: Header `x-api-key: YOUR_SECRET_KEY`

---

## Deployment (GitHub Actions)

This project is configured to auto-deploy to your VPS on every push to the `main` branch.

### Required GitHub Secrets:
1.  **`VPS_SSH_HOST`**: Your VPS IP address.
2.  **`VPS_SSH_USER`**: Your VPS username (e.g., `root`).
3.  **`VPS_SSH_KEY`**: Your private SSH key (RSA/ED25519).
4.  **`VPS_SSH_PASSWORD`**: (Fallback) Your VPS password.
5.  **`IMAGE_SERVER_SECRET`**: Any random string used as your API Key.
6.  **`BASE_URL`**: Your public server URL.

---

## Manual Run (Docker Compose)
If you want to run it locally or manually on your server:

1. Create a `.env` file:
   ```env
   IMAGE_SERVER_SECRET=your_random_secret
   BASE_URL=http://localhost:4000
   ```
2. Start the server:
   ```bash
   docker compose up -d --build
   ```

---

## Tech Stack
- **Runtime**: [Bun](https://bun.sh)
- **Image Processing**: [Sharp](https://sharp.pixelplumbing.com/)
- **Deployment**: Docker, GitHub Actions, Appleboy SSH/SCP
