#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";


const command = 'npx' ;
const args = ['-y', '@felores/airtable-mcp-server'];

let dirtyApiKey = process.env.AIRTABLE_API_KEY || '';
let cleanApiKey = '';

if (dirtyApiKey) {
  // 2. Find the beginning of the real key, "pat"
  const patIndex = dirtyApiKey.indexOf('pat');

  if (patIndex !== -1) {
    // 3. Slice the string from "pat" to the end. This strips all leading junk.
    cleanApiKey = dirtyApiKey.substring(patIndex);
    console.log(`✅ API Key CLEANED. It now starts with: ${cleanApiKey.substring(0, 3)}... and ends with: ...${cleanApiKey.slice(-2)}`);
  } else {
    console.error(`❌ CRITICAL: Found the key, but could not find the required 'pat...' sequence in it.`);
  }
} else {
  console.error('❌ CRITICAL: AIRTABLE_API_KEY is NOT FOUND in the environment!');
}


// 2. Spawn the MCP process
const safeArgsForLogging = [...args];
if (safeArgsForLogging.length > 1) {
  const key = safeArgsForLogging[1];
  safeArgsForLogging[1] = `pat...${key.slice(-2)}`; // Mask the API key
}
console.log(`Spawning MCP process with command: ${command} ${safeArgsForLogging.join(' ')}`);

const mcp = spawn(command, args, {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});

// Listen for errors from the MCP process
mcp.stderr.on("data", (data) => {
  console.error(`MCP stderr: ${data.toString()}`);
});

// Listen for when the MCP process closes
mcp.on("close", (code) => {
  console.log(`MCP process exited with code ${code}`);
});

// Listen for spawn errors (e.g., command not found)
mcp.on('error', (err) => {
  console.error('Failed to start MCP subprocess.', err);
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
  console.log(`Received data from MCP stdout: ${data.toString()}`); // Added for logging
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
  app.get("/sse", async (req, res) => {
  console.log("New SSE connection.");
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  if (mcp.stdin.writable) {   
    
    console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', req.body);
  console.log("#########################")
  const apiKey = req.headers['x-api-key'];
  console.log('Received headers:', req.headers);
  console.log('API Key:', apiKey);
  next();

    
    const singleLineJson = JSON.stringify(JSON.parse(req.body));
    mcp.stdin.write(singleLineJson + "\n");
    res.sendStatus(202);
  } else {
    console.error("Attempted to write to a closed MCP stdin.");
    res.status(500).send("MCP stdin closed");
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
