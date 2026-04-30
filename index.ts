import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

// Load environment variables manually if needed, but Bun does this automatically!
const PORT = process.env.PORT || 4001;
const SECRET_KEY = process.env.IMAGE_SERVER_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STATIC_DIR = path.join(import.meta.dir, 'public/images');

// Ensure upload directory exists
if (!fs.existsSync(STATIC_DIR)) {
    fs.mkdirSync(STATIC_DIR, { recursive: true });
}

console.log(`🚀 Starting Bun Image Server...`);
console.log(`📡 Port: ${PORT}`);
console.log(`🌐 Base URL: ${BASE_URL}`);
console.log(`📁 Storage: ${STATIC_DIR}`);
console.log(`🔐 API Key Set: ${SECRET_KEY ? '✅ Yes' : '❌ No (Check IMAGE_SERVER_SECRET env)'}`);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        
        // Detailed Request Logging
        console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`);

        // Security Helper
        const isAuthorized = () => {
            const apiKey = req.headers.get('x-api-key') || url.searchParams.get('key');
            return apiKey === SECRET_KEY;
        };

        // 1. Enhanced Health Check
        if (url.pathname === '/health') {
            const storageExists = fs.existsSync(STATIC_DIR);
            let storageWritable = false;
            try {
                if (storageExists) {
                    const testFile = path.join(STATIC_DIR, '.health-check');
                    fs.writeFileSync(testFile, 'ok');
                    fs.unlinkSync(testFile);
                    storageWritable = true;
                }
            } catch (e) {}

            return Response.json({
                status: storageExists && storageWritable && SECRET_KEY ? 'ok' : 'error',
                timestamp: new Date().toISOString(),
                config: {
                    port: PORT,
                    baseUrl: BASE_URL,
                    apiKeyConfigured: !!SECRET_KEY
                },
                storage: {
                    path: STATIC_DIR,
                    exists: storageExists,
                    writable: storageWritable
                }
            }, { status: (storageExists && storageWritable && SECRET_KEY) ? 200 : 500 });
        }

        // 2. Admin Dashboard
        if ((url.pathname === '/admin' || url.pathname === '/admin.html') && req.method === 'GET') {
            if (!isAuthorized()) {
                return new Response('<h1>Unauthorized</h1><p>Please provide a valid ?key=YOUR_SECRET in the URL.</p>', { 
                    status: 401, 
                    headers: { 'Content-Type': 'text/html' } 
                });
            }
            const html = fs.readFileSync(path.join(import.meta.dir, 'admin.html'), 'utf8');
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        }

        // 2. Serve Static Images
        if (url.pathname.startsWith('/images/') && req.method === 'GET') {
            const filename = url.pathname.replace('/images/', '');
            const filepath = path.join(STATIC_DIR, filename);
            const file = Bun.file(filepath);
            if (await file.exists()) {
                return new Response(file);
            }
            return new Response('Not Found', { status: 404 });
        }

        // --- Protected Routes Below ---
        if (!isAuthorized()) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 3. Upload Image
        if (url.pathname === '/upload' && req.method === 'POST') {
            try {
                const formData = await req.formData();
                const file = formData.get('file') as File;

                if (!file) {
                    return Response.json({ error: 'No file uploaded' }, { status: 400 });
                }

                // Generate unique base filename
                const timestamp = Date.now();
                const random = Math.round(Math.random() * 1e9);
                const baseFilename = `img-${timestamp}-${random}`;
                const webpFilename = `${baseFilename}.webp`;
                const pngFilename = `${baseFilename}.png`;

                const webpPath = path.join(STATIC_DIR, webpFilename);
                const pngPath = path.join(STATIC_DIR, pngFilename);

                // Process image with Sharp
                const arrayBuffer = await file.arrayBuffer();
                const imageBuffer = Buffer.from(arrayBuffer);

                // Generate WebP
                await sharp(imageBuffer)
                    .resize({ width: 1920, withoutEnlargement: true })
                    .toFormat('webp', { quality: 80 })
                    .toFile(webpPath);

                // Generate PNG
                await sharp(imageBuffer)
                    .resize({ width: 1920, withoutEnlargement: true })
                    .toFormat('png')
                    .toFile(pngPath);

                console.log(`Successfully uploaded: ${webpFilename} and ${pngFilename}`);

                return Response.json({
                    success: true,
                    url: `${BASE_URL}/images/${webpFilename}`, // Default URL (WebP)
                    webp_url: `${BASE_URL}/images/${webpFilename}`,
                    png_url: `${BASE_URL}/images/${pngFilename}`,
                    details: {
                        baseFilename,
                        webp: {
                            filename: webpFilename,
                            mimetype: 'image/webp',
                            size: fs.statSync(webpPath).size
                        },
                        png: {
                            filename: pngFilename,
                            mimetype: 'image/png',
                            size: fs.statSync(pngPath).size
                        }
                    }
                });
            } catch (error) {
                return Response.json({ error: (error as Error).message }, { status: 500 });
            }
        }

        // 4. List Images
        if (url.pathname === '/list' && req.method === 'GET') {
            try {
                const files = fs.readdirSync(STATIC_DIR);
                const images = files.map(filename => {
                    const stats = fs.statSync(path.join(STATIC_DIR, filename));
                    return {
                        filename,
                        url: `${BASE_URL}/images/${filename}`,
                        size: stats.size,
                        mtime: stats.mtime
                    };
                });
                images.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
                return Response.json(images);
            } catch (error) {
                return Response.json({ error: (error as Error).message }, { status: 500 });
            }
        }

        // 5. Delete Image
        if (url.pathname.startsWith('/images/') && req.method === 'DELETE') {
            try {
                const filename = url.pathname.replace('/images/', '');
                const filepath = path.join(STATIC_DIR, filename);

                if (!fs.existsSync(filepath)) {
                    return Response.json({ error: 'File not found' }, { status: 404 });
                }

                fs.unlinkSync(filepath);
                console.log(`Deleted: ${filename}`);
                return Response.json({ success: true, message: `Deleted ${filename}` });
            } catch (error) {
                return Response.json({ error: (error as Error).message }, { status: 500 });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
});
