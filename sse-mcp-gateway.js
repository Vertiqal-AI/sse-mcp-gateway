#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

dotenv.config();

// --- API Key Validation ---
let cleanApiKey = '';
const dirtyApiKey = process.env.AIRTABLE_API_KEY || '';
if (dirtyApiKey && dirtyApiKey.includes('pat')) {
  cleanApiKey = dirtyApiKey.substring(dirtyApiKey.indexOf('pat'));
  console.log(`✅ API Key Loaded and Cleaned.`);
} else {
  console.error('❌ FATAL: AIRTABLE_API_KEY is not defined or is invalid! Please set it in Railway.');
  process.exit(1);
}

// --- Spawn MCP Server ---
const command = 'node';
const mcpScriptPath = './airtable-mcp-src/build/index.js';
const args = [ mcpScriptPath ];
console.log(`Spawning MCP process with command: ${command} ${args[0]}`);

const mcp = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, 'AIRTABLE_API_KEY': cleanApiKey }
});

// --- Child Process Event Handlers ---
mcp.stderr.on("data", (data) => console.error(`MCP stderr: ${data.toString()}`));
mcp.on("close", (code) => console.log(`MCP process exited with code ${code}`));
mcp.on('error', (err) => console.error('Failed to start MCP subprocess.', err));

// --- Setup Express Server ---
const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.text({ type: "*/*" }));

// --- Manually Manage a List of Connected Clients ---
// This is a robust way to handle multiple connections.
const connectedClients = new Set();

// --- Handle HTTP Endpoints ---
app.get("/sse", (req, res) => {
  console.log("New SSE client connected.");
  const transport = new SSEServerTransport("/message", res);
  
  // Add the new client to our active set
  connectedClients.add(transport);
  console.log(`Client added. Total clients: ${connectedClients.size}`);

  // When the client disconnects, remove them from the set
  req.on('close', () => {
    connectedClients.delete(transport);
    console.log(`Client disconnected. Total clients: ${connectedClients.size}`);
  });
});

app.post("/message", async (req, res) => {
  if (mcp.stdin.writable) {
    try {
      const singleLineJson = JSON.stringify(JSON.parse(req.body));
      mcp.stdin.write(singleLineJson + "\n");
      res.sendStatus(202);
    } catch (e) {
      res.status(400).send("Invalid JSON");
    }
  } else {
    res.status(500).send("MCP stdin closed");
  }
});

// --- Handle Data from the Child Process ---
let stdoutBuffer = '';
mcp.stdout.on("data", (data) => {
  stdoutBuffer += data.toString();
  let newlineIndex;

  while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.substring(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);

    if (line) {
      try {
        const json = JSON.parse(line);
        
        // Loop through all currently connected clients and send them the data
        console.log(`Broadcasting message to ${connectedClients.size} client(s).`);
        for (const client of connectedClients) {
          client.send(json);
        }
      } catch (err) {
        console.error("Error parsing or broadcasting line from MCP stdout:", line);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
