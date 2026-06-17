
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      'process.env.DEEPGRAM_API_KEY': JSON.stringify(env.DEEPGRAM_API_KEY || ""),
      'process.env.AZURE_OPENAI_ENDPOINT': JSON.stringify(env.AZURE_OPENAI_ENDPOINT || ""),
      'process.env.AZURE_OPENAI_API_VERSION': JSON.stringify(env.AZURE_OPENAI_API_VERSION || ""),
      'process.env.AZURE_OPENAI_EMBEDDING_API_VERSION': JSON.stringify(env.AZURE_OPENAI_EMBEDDING_API_VERSION || ""),
      'process.env.AZURE_OPENAI_CHAT_DEPLOYMENT': JSON.stringify(env.AZURE_OPENAI_CHAT_DEPLOYMENT || ""),
      'process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT': JSON.stringify(env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || ""),
      'process.env.AZURE_OPENAI_EMBEDDING_MODEL': JSON.stringify(env.AZURE_OPENAI_EMBEDDING_MODEL || ""),
      'process.env.AZURE_OPENAI_API_KEY': JSON.stringify(env.AZURE_OPENAI_API_KEY || "")
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
