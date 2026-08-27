import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Configuration
const PORT = Number(process.env.PORT) || 4000;
const SECRET_KEY = process.env.IMAGE_SERVER_SECRET || '';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const STATIC_DIR = process.env.STATIC_DIR || path.join(import.meta.dir, 'public/images');
const MAX_IMAGE_WIDTH = 1920;
const DEFAULT_EXPIRATION_SECONDS = 300; // 5 minutes
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// Supported target output formats
const ALLOWED_FORMATS = ['webp', 'png'] as const;
type AllowedFormat = typeof ALLOWED_FORMATS[number];

// Ensure upload directory exists
if (!fs.existsSync(STATIC_DIR)) {
    fs.mkdirSync(STATIC_DIR, { recursive: true });
}

// Track consumed presigned signatures to prevent replay attacks (with TTL cleanup)
const usedSignatures = new Map<string, number>();

setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const [sig, expiry] of usedSignatures.entries()) {
        if (now > expiry) {
            usedSignatures.delete(sig);
        }
    }
}, 60 * 1000);

// Helper: HMAC Signature Generator
function generateSignature(params: {
    method: string;
    path: string;
    fileKey: string;
    format: string;
    expires: number;
    maxSize: number;
}): string {
    const canonicalString = [
        params.method.toUpperCase(),
        params.path,
        params.fileKey,
        params.format,
        params.expires.toString(),
        params.maxSize.toString(),
    ].join('\n');

    return crypto
        .createHmac('sha256', SECRET_KEY)
        .update(canonicalString)
        .digest('hex');
}

// Helper: Safe Signature Verification
function verifySignature(expectedSig: string, providedSig: string): boolean {
    if (!expectedSig || !providedSig || expectedSig.length !== providedSig.length) {
        return false;
    }
    try {
        return crypto.timingSafeEqual(
            Buffer.from(expectedSig, 'hex'),
            Buffer.from(providedSig, 'hex')
        );
    } catch {
        return false;
    }
}

// Helper: Universal Dynamic CORS Headers
function corsHeaders(req?: Request, extraHeaders: Record<string, string> = {}): Record<string, string> {
    const origin = req?.headers.get('origin') || ALLOWED_ORIGIN;
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
        'Access-Control-Max-Age': '86400',
        ...extraHeaders,
    };
}

// Helper: JSON Response with CORS
function jsonResponse(req: Request, data: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: corsHeaders(req, {
            'Content-Type': 'application/json',
            ...headers,
        }),
    });
}

console.log(`🚀 Starting Bun Image Service (S3-Compatible Direct Upload)...`);
console.log(`📡 Port: ${PORT}`);
console.log(`🌐 Base URL: ${BASE_URL}`);
console.log(`📁 Storage: ${STATIC_DIR}`);
console.log(`🔐 Secret Configured: ${SECRET_KEY ? '✅ Yes' : '❌ No (Set IMAGE_SERVER_SECRET)'}`);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // 1. Handle CORS Preflight (Universal 204 with full wildcard headers)
        if (req.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(req),
            });
        }

        // Auth Helper for Master API Key
        const isAuthorized = () => {
            const apiKey = req.headers.get('x-api-key') || url.searchParams.get('key');
            return !!SECRET_KEY && apiKey === SECRET_KEY;
        };

        // 2. Health Check (Public)
        if (url.pathname === '/health' && req.method === 'GET') {
            const storageExists = fs.existsSync(STATIC_DIR);
            let storageWritable = false;
            try {
                if (storageExists) {
                    const testFile = path.join(STATIC_DIR, '.health-check');
                    fs.writeFileSync(testFile, 'ok');
                    fs.unlinkSync(testFile);
                    storageWritable = true;
                }
            } catch {
                storageWritable = false;
            }

            const healthy = storageExists && storageWritable && !!SECRET_KEY;
            return jsonResponse(req, {
                status: healthy ? 'ok' : 'error',
                service: 'bun-image-service',
                mode: 's3-presigned-direct-upload',
                timestamp: new Date().toISOString(),
                config: {
                    port: PORT,
                    baseUrl: BASE_URL,
                    secretConfigured: !!SECRET_KEY,
                },
                storage: {
                    path: STATIC_DIR,
                    exists: storageExists,
                    writable: storageWritable,
                },
            }, healthy ? 200 : 500);
        }

        // 3. Serve Static Images (Public)
        if (url.pathname.startsWith('/images/') && req.method === 'GET') {
            const filename = path.basename(url.pathname);
            const filepath = path.join(STATIC_DIR, filename);
            const file = Bun.file(filepath);

            if (await file.exists()) {
                const ext = path.extname(filename).toLowerCase();
                const mimeType = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'application/octet-stream';

                return new Response(file, {
                    headers: corsHeaders(req, {
                        'Content-Type': mimeType,
                        'Cache-Control': 'public, max-age=31536000, immutable',
                    }),
                });
            }
            return jsonResponse(req, { error: 'Image not found' }, 404);
        }

        // 4. Generate Pre-signed Direct Upload URL (Server-to-Server / Protected by API Key)
        if ((url.pathname === '/api/presign' || url.pathname === '/presigned-url') && req.method === 'POST') {
            if (!isAuthorized()) {
                return jsonResponse(req, { error: 'Unauthorized: Invalid or missing API key' }, 401);
            }

            try {
                const body = await req.json().catch(() => ({}));
                const requestedFormat = (body.format || 'webp').toLowerCase() as AllowedFormat;

                if (!ALLOWED_FORMATS.includes(requestedFormat)) {
                    return jsonResponse(req, {
                        error: `Invalid format '${requestedFormat}'. Supported formats are: ${ALLOWED_FORMATS.join(', ')}`
                    }, 400);
                }

                const expiresIn = Math.min(
                    Math.max(Number(body.expiresIn) || DEFAULT_EXPIRATION_SECONDS, 30),
                    3600 // Max 1 hour
                );
                const maxSizeBytes = Number(body.maxSizeBytes) || DEFAULT_MAX_SIZE_BYTES;
                const expires = Math.floor(Date.now() / 1000) + expiresIn;

                // Unique file key with target extension
                const timestamp = Date.now();
                const random = crypto.randomBytes(6).toString('hex');
                const fileKey = `img-${timestamp}-${random}.${requestedFormat}`;

                // Calculate HMAC signature
                const signature = generateSignature({
                    method: 'PUT',
                    path: '/upload/direct',
                    fileKey,
                    format: requestedFormat,
                    expires,
                    maxSize: maxSizeBytes,
                });

                // Construct direct upload URL
                const queryParams = new URLSearchParams({
                    fileKey,
                    expires: expires.toString(),
                    format: requestedFormat,
                    maxSize: maxSizeBytes.toString(),
                    signature,
                });

                const uploadUrl = `${BASE_URL}/upload/direct?${queryParams.toString()}`;
                const publicUrl = `${BASE_URL}/images/${fileKey}`;

                return jsonResponse(req, {
                    success: true,
                    uploadUrl,
                    method: 'PUT',
                    fileKey,
                    format: requestedFormat,
                    publicUrl,
                    expiresAt: expires,
                    expiresInSeconds: expiresIn,
                    maxSizeBytes,
                    headersRequired: {
                        'Content-Type': 'image/*'
                    }
                });
            } catch (error: any) {
                return jsonResponse(req, { error: error.message }, 500);
            }
        }

        // 5. Direct Binary Image Upload (Public via S3-style Presigned Signature)
        if (url.pathname === '/upload/direct' && req.method === 'PUT') {
            try {
                const fileKey = url.searchParams.get('fileKey');
                const expiresStr = url.searchParams.get('expires');
                const format = url.searchParams.get('format') as AllowedFormat;
                const maxSizeStr = url.searchParams.get('maxSize');
                const signature = url.searchParams.get('signature');

                if (!fileKey || !expiresStr || !format || !maxSizeStr || !signature) {
                    return jsonResponse(req, { error: 'Missing required presigned parameters' }, 400);
                }

                if (!ALLOWED_FORMATS.includes(format)) {
                    return jsonResponse(req, { error: 'Unsupported format in presigned token' }, 400);
                }

                const expires = Number(expiresStr);
                const maxSize = Number(maxSizeStr);
                const now = Math.floor(Date.now() / 1000);

                // Check Expiration
                if (now > expires) {
                    return jsonResponse(req, { error: 'Presigned upload URL has expired' }, 403);
                }

                // Check Replay (One-Time Use)
                if (usedSignatures.has(signature)) {
                    return jsonResponse(req, { error: 'Presigned upload URL has already been used' }, 409);
                }

                // Validate HMAC Signature
                const expectedSignature = generateSignature({
                    method: 'PUT',
                    path: '/upload/direct',
                    fileKey,
                    format,
                    expires,
                    maxSize,
                });

                if (!verifySignature(expectedSignature, signature)) {
                    return jsonResponse(req, { error: 'Invalid presigned signature or tampered parameters' }, 403);
                }

                // Check Content-Length header if provided
                const contentLength = Number(req.headers.get('content-length') || 0);
                if (contentLength > maxSize) {
                    return jsonResponse(req, {
                        error: `File size exceeds allowed limit of ${maxSize} bytes`
                    }, 413);
                }

                // Read binary body
                const arrayBuffer = await req.arrayBuffer();
                if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                    return jsonResponse(req, { error: 'Empty file body received' }, 400);
                }

                if (arrayBuffer.byteLength > maxSize) {
                    return jsonResponse(req, {
                        error: `Payload size (${arrayBuffer.byteLength} bytes) exceeds limit of ${maxSize} bytes`
                    }, 413);
                }

                const inputBuffer = Buffer.from(arrayBuffer);

                // Process image with Sharp (Validates genuine image bytes & sanitizes)
                const safeFilename = path.basename(fileKey);
                const outputPath = path.join(STATIC_DIR, safeFilename);

                let sharpInstance = sharp(inputBuffer)
                    .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true });

                if (format === 'webp') {
                    sharpInstance = sharpInstance.webp({ quality: 80 });
                } else if (format === 'png') {
                    sharpInstance = sharpInstance.png({ compressionLevel: 8 });
                }

                await sharpInstance.toFile(outputPath);

                // Invalidate signature immediately (Prevent duplicate uploads)
                usedSignatures.set(signature, expires);

                const fileStats = fs.statSync(outputPath);
                const publicUrl = `${BASE_URL}/images/${safeFilename}`;

                console.log(`[Upload Success] ${safeFilename} (${format.toUpperCase()}, ${fileStats.size} bytes)`);

                return jsonResponse(req, {
                    success: true,
                    url: publicUrl,
                    fileKey: safeFilename,
                    format,
                    size: fileStats.size,
                    contentType: format === 'webp' ? 'image/webp' : 'image/png',
                }, 200);

            } catch (error: any) {
                console.error('[Upload Error]', error);
                const msg = error.message || 'Image processing failed';
                return jsonResponse(req, {
                    error: msg.includes('Input buffer contains unsupported image format')
                        ? 'Invalid image file: File is corrupted or not a supported image format'
                        : msg
                }, 400);
            }
        }

        // --- Master API Key Protected Management Endpoints ---
        if (!isAuthorized()) {
            return jsonResponse(req, { error: 'Unauthorized' }, 401);
        }

        // 6. List All Images (Protected)
        if (url.pathname === '/list' && req.method === 'GET') {
            try {
                const files = fs.readdirSync(STATIC_DIR).filter(f => !f.startsWith('.'));
                const images = files.map(filename => {
                    const stats = fs.statSync(path.join(STATIC_DIR, filename));
                    const ext = path.extname(filename).replace('.', '').toLowerCase();
                    return {
                        filename,
                        url: `${BASE_URL}/images/${filename}`,
                        format: ext,
                        size: stats.size,
                        mtime: stats.mtime
                    };
                });
                images.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
                return jsonResponse(req, images);
            } catch (error: any) {
                return jsonResponse(req, { error: error.message }, 500);
            }
        }

        // 7. Delete Image (Protected)
        if (url.pathname.startsWith('/images/') && req.method === 'DELETE') {
            try {
                const filename = path.basename(url.pathname);
                const filepath = path.join(STATIC_DIR, filename);

                if (!fs.existsSync(filepath)) {
                    return jsonResponse(req, { error: 'File not found' }, 404);
                }

                fs.unlinkSync(filepath);
                console.log(`[Deleted] ${filename}`);
                return jsonResponse(req, { success: true, message: `Deleted ${filename}` });
            } catch (error: any) {
                return jsonResponse(req, { error: error.message }, 500);
            }
        }

        return jsonResponse(req, { error: 'Not Found' }, 404);
    },
});
