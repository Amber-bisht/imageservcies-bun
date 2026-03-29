import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

// Load environment variables manually if needed, but Bun does this automatically!
const PORT = process.env.PORT || 4000;
const SECRET_KEY = process.env.IMAGE_SERVER_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STATIC_DIR = path.join(import.meta.dir, 'public/images');

// Ensure upload directory exists
if (!fs.existsSync(STATIC_DIR)) {
    fs.mkdirSync(STATIC_DIR, { recursive: true });
}

console.log(`🚀 Starting Bun Image Server...`);
console.log(`📁 Images stored in: ${STATIC_DIR}`);

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // Security Helper
        const isAuthorized = () => {
            const apiKey = req.headers.get('x-api-key');
            return apiKey === SECRET_KEY;
        };

        // 1. Health Check
        if (url.pathname === '/health') {
            return Response.json({ status: 'ok', storage: STATIC_DIR });
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

                // Generate unique filename
                const filename = `img-${Date.now()}-${Math.round(Math.random() * 1e9)}.webp`;
                const filepath = path.join(STATIC_DIR, filename);

                // Process image with Sharp
                const arrayBuffer = await file.arrayBuffer();
                await sharp(Buffer.from(arrayBuffer))
                    .resize({ width: 1920, withoutEnlargement: true })
                    .toFormat('webp', { quality: 80 })
                    .toFile(filepath);

                console.log(`Successfully uploaded: ${filename}`);

                return Response.json({
                    success: true,
                    url: `${BASE_URL}/images/${filename}`,
                    details: {
                        filename,
                        mimetype: 'image/webp',
                        size: fs.statSync(filepath).size
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
