#!/usr/bin/env node

import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Load environment variables from Railway's variable manager
dotenv.config();

// --- API Key Cleaning and Validation ---
let cleanApiKey = '';
const dirtyApiKey = process.env.AIRTABLE_API_KEY || '';

if (dirtyApiKey) {
  const patIndex = dirtyApiKey.indexOf('pat');
  if (patIndex !== -1) {
    cleanApiKey = dirtyApiKey.substring(patIndex);
    console.log(`✅ API Key Loaded and Cleaned.`);
  } else {
    console.error(`❌ FATAL: Could not find 'pat...' sequence in AIRTABLE_API_KEY.`);
    process.exit(1); // Exit if the key format is wrong
  }
} else {
  console.error('❌ FATAL: AIRTABLE_API_KEY is NOT DEFINED in environment! Please set it in Railway.');
  process.exit(1); // Exit if the key is missing
}

// --- Define the command to run the pre-built MCP server ---
const command = 'node';
// This path now correctly matches the final location from our Dockerfile
const mcpScriptPath = './airtable-mcp-src/build/index.js';
const args = [ mcpScriptPath ]; // We pass the key via 'env' now

console.log(`Spawning MCP process with command: ${command} ${args[0]}`);

const mcp = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  // This is the correct way to pass the key to the original MCP server code
  env: {
    ...process.env,
    'AIRTABLE_API_KEY': cleanApiKey
  }
});

// Listen for errors from the MCP process
mcp.stderr.on("data", (data) => {
  console.error(`MCP stderr: ${data.toString()}`);
});

mcp.on("close", (code) => {
  console.log(`MCP process exited with code ${code}`);
});

mcp.on('error', (err) => {
  console.error('Failed to start MCP subprocess.', err);
});


// --- Setup Express and SSE transport ---
const app = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.text({ type: "*/*" }));

let transport;

app.get("/sse", (req, res) => {
  console.log("New SSE connection.");
  transport = new SSEServerTransport("/message", res);
});

app.post("/message", async (req, res) => {
  if (mcp.stdin.writable) {
    try {
        const singleLineJson = JSON.stringify(JSON.parse(req.body));
        mcp.stdin.write(singleLineJson + "\n");
        res.sendStatus(202);
    } catch(e) {
        res.status(400).send("Invalid JSON");
    }
  } else {
    res.status(500).send("MCP stdin closed");
  }
});

mcp.stdout.on("data", (data) => {
  const lines = data.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      transport?.send(json);
    } catch (err) {
      console.error("Invalid JSON from MCP:", line);
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ MCP Gateway running at http://localhost:${PORT}/sse`);
});
