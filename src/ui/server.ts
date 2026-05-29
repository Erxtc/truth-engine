import { subscribe, history, type UIEvent } from "./events";
import { db } from "../db/client";
import { join } from "path";

const PORT = Number(process.env.UI_PORT ?? 4242);
const DIST  = join(import.meta.dir, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".woff2":"font/woff2",
};

function ext(path: string) {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i) : "";
}

export function startUiServer(): void {
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    server = Bun.serve({
      port: PORT,
      reusePort: true,
    async fetch(req) {
      const url = new URL(req.url);

      // ── SSE stream ────────────────────────────────────────────────────
      if (url.pathname === "/events") {
        let unsub: (() => void) | null = null;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            for (const e of history.slice(-300)) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            }
            unsub = subscribe((e: UIEvent) => {
              try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { unsub?.(); }
            });
          },
          cancel() { unsub?.(); },
        });
        return new Response(stream, {
          headers: {
            "Content-Type":    "text/event-stream",
            "Cache-Control":   "no-cache",
            "Connection":      "keep-alive",
            "X-Accel-Buffering":"no",
          },
        });
      }

      // ── API ───────────────────────────────────────────────────────────
      if (url.pathname === "/api/state")     return handleState();
      if (url.pathname === "/api/artifacts") return handleArtifacts();

      // ── Static files from dist/ ───────────────────────────────────────
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file   = Bun.file(join(DIST, filePath));

      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": MIME[ext(filePath)] ?? "application/octet-stream" },
        });
      }

      // SPA fallback
      const index = Bun.file(join(DIST, "index.html"));
      if (await index.exists()) {
        return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response(
        "UI not built — run: bun run ui:build",
        { status: 503, headers: { "Content-Type": "text/plain" } },
      );
    },
  });

  console.log(`[ui] Dashboard → http://localhost:${server.port}`);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      console.log(`[ui] Port ${PORT} in use — dashboard skipped`);
      return;
    }
    throw err;
  }
}

async function handleState(): Promise<Response> {
  try {
    const problem = await db
      .selectFrom("problems")
      .selectAll()
      .orderBy("createdAt" as any, "desc")
      .limit(1)
      .executeTakeFirst();

    if (!problem) return Response.json({ problem: null });

    const stepPlan = (problem as any).stepPlan
      ? JSON.parse((problem as any).stepPlan)
      : null;

    return Response.json({
      problem: {
        id: problem.id,
        domain: problem.domain,
        status: problem.status,
        description: problem.description,
      },
      stepPlan,
      currentStep: (problem as any).currentStep ?? 0,
      runParams: null,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

async function handleArtifacts(): Promise<Response> {
  try {
    const problem = await db
      .selectFrom("problems")
      .select("id")
      .orderBy("createdAt" as any, "desc")
      .limit(1)
      .executeTakeFirst();

    if (!problem) return Response.json([]);

    const rows = await db
      .selectFrom("artifacts")
      .select([
        "id", "type", "status", "score", "depth", "parentId",
        "hypothesisText", "title", "sourceCode", "confidenceLevel",
      ])
      .where("problemId", "=", problem.id)
      .where("type", "!=", "failure_report")
      .orderBy("createdAt" as any, "asc")
      .limit(200)
      .execute();

    return Response.json(rows);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
