#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOfferlayerMcp } from "./server.ts";

const apiBase = process.env.OFFERLAYER_URL ?? "http://127.0.0.1:8787";
const agentKey = process.env.OFFERLAYER_AGENT_KEY;
const sellerKey = process.env.OFFERLAYER_SELLER_KEY;
const server = createOfferlayerMcp({ apiBase, agentKey, sellerKey });
const transport = new StdioServerTransport();
await server.connect(transport);
