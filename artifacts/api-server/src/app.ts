import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import path from "path";
import { fileURLToPath } from "url";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production, serve the built frontend and handle SPA routing.
// In development, the Vite dev server (port 24245) is proxied instead.
if (process.env.NODE_ENV === "production") {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/index.mjs → dist/ → artifacts/api-server/ → artifacts/ → workspace root
  // Frontend build output: artifacts/youtube-arabic/dist/public
  const publicDir = path.resolve(__dirname, "..", "..", "youtube-arabic", "dist", "public");

  app.use(express.static(publicDir));

  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
} else {
  // Development: proxy everything that is not an /api route to Vite dev server.
  const vitePort = process.env.VITE_PORT ?? "24245";
  const { createProxyMiddleware } = await import("http-proxy-middleware");
  const viteProxy = createProxyMiddleware({
    target: `http://localhost:${vitePort}`,
    changeOrigin: true,
    ws: true,
    on: {
      error(err, _req, res) {
        if (res && typeof (res as { headersSent?: boolean }).headersSent !== "undefined") {
          const httpRes = res as import("http").ServerResponse;
          if (!httpRes.headersSent) {
            httpRes.writeHead(502);
            httpRes.end("Vite dev server not ready yet — please wait a moment and refresh.");
          }
        }
      },
    },
  });
  app.use(viteProxy);
}

export default app;
