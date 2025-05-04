npx -y @elastic/mcp-server-elasticsearch
 ^C
 ^C
 cat .env 
ES_URL=https://es.localhost.localdomain
ES_USERNAME=elastic
ES_PASSWORD=OXLK4Dwh
 
 
 cat sse-mcp-gateway.js 
#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Load .env variables (if provided)
const envFilePath = process.argv[3] || ".env";
if (fs.existsSync(envFilePath)) {
  dotenv.config({ path: envFilePath });
}

// 1. Read MCP launch command from config file
const configPath = process.argv[2] || "mcp-command.txt";
if (!fs.existsSync(configPath)) {
  console.error(`Missing MCP command file: ${configPath}`);
  process.exit(1);
}

const mcpCommand = fs.readFileSync(configPath, "utf8").trim().split(" ");
const [command, ...args] = mcpCommand;

// 2. Spawn the MCP process
const mcp = spawn(command, args, {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});

// 3. Setup Express and SSE transport
const app = express();
const PORT = process.env.PORT || 8808;
app.use(cors());
app.use(express.text({ type: "*/*" }));

let transport;

const server = new Server(
  { name: "GenericMCP-Gateway", version: "0.1.0" },
  {
    capabilities: {
      resources: {},
      tools: {},
      templates: {},
    },
  }
);

// 4. Forward stdout → SSE
mcp.stdout.on("data", (data) => {
  const lines = data.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const json = JSON.parse(line);

      // Normalize content format
      if (json.result?.content) {
        const rawContent = Array.isArray(json.result.content)
          ? json.result.content
          : [json.result.content];

        const joinedText = rawContent.map((entry) => {
          if (typeof entry === "string") {
            try {
              const parsed = JSON.parse(entry);
              return JSON.stringify(parsed, null, 2);
            } catch {
              return entry;
            }
          }

          if (typeof entry === "object" && typeof entry.text === "string") {
            return entry.text;
          }

          return JSON.stringify(entry, null, 2);
        }).join("\n\n");

        json.result.content = "```\n" + joinedText + "\n```";
      }

      transport?.send(json);
    } catch (err) {
      console.error("Invalid JSON from MCP:", line);
    }
  }
});

// 5. Define HTTP endpoints
app.get("/sse", async (req, res) => {
  console.log("New SSE connection.");
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  if (mcp.stdin.writable) {
    mcp.stdin.write(req.body + "\n");
    res.sendStatus(202);
  } else {
    res.status(500).send("MCP stdin closed");
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
