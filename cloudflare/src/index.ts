// office_mcp.py와 같은 도구 2개를 Cloudflare Workers 원격 MCP 서버(Streamable HTTP)로 제공한다.
// DB는 D1(office.db와 같은 스키마), 조회만 한다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface Env {
  DB: D1Database;
  MCP_TOKEN: string; // wrangler secret
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "office", version: "1.0.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  const rows = async (sql: string, ...args: unknown[]) => {
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results) }],
      structuredContent: { result: results },
    };
  };

  server.registerTool(
    "site_workforce",
    {
      description: "현장 이름과 YYYY-MM-DD 날짜로 공종별 출역 업체와 인원을 찾는다.",
      inputSchema: { site: z.string(), date: DATE },
      annotations: readOnly,
    },
    ({ site, date }) =>
      rows("SELECT trade, company, workers FROM workforce WHERE site = ? AND date = ? ORDER BY trade", site, date),
  );

  server.registerTool(
    "equipment_schedule",
    {
      description: "현장의 YYYY-MM-DD 날짜 장비 사용 예약을 시작 시간 순서로 돌려준다.",
      inputSchema: { site: z.string(), date: DATE },
      annotations: readOnly,
    },
    ({ site, date }) =>
      rows("SELECT equipment, start, \"end\", company FROM bookings WHERE site = ? AND date = ? ORDER BY start", site, date),
  );

  return server;
}

async function authorized(req: Request, env: Env): Promise<boolean> {
  if (!env.MCP_TOKEN) return false; // 시크릿 미설정이면 전부 거부
  const got = req.headers.get("Authorization") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(got)),
    crypto.subtle.digest("SHA-256", enc.encode(`Bearer ${env.MCP_TOKEN}`)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/mcp") {
      return new Response("safety-check MCP server. Endpoint: /mcp", { status: 404 });
    }
    if (!(await authorized(req, env))) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }
    // 무상태: 요청마다 서버/전송 객체를 새로 만든다.
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  },
} satisfies ExportedHandler<Env>;
