import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

export default defineConfig({
    plugins: [react()],
    root: __dirname,
    base: '/',
    build: {
        outDir: path.join(appRoot, 'dist/ui'),
        assetsDir: 'app-assets',
        emptyOutDir: true,
        sourcemap: true,
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
            '/public': { target: 'http://127.0.0.1:3001', changeOrigin: true },
        },
    },
});
