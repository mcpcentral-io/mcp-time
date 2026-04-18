#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import weekOfYear from 'dayjs/plugin/weekOfYear.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(weekOfYear);
dayjs.extend(isoWeek);

export interface Env {}

const SERVER_NAME = 'mcp-time';
const SERVER_VERSION = '0.0.5';

// 2025-11-25 is the latest and preferred version.
const SUPPORTED_PROTOCOL_VERSIONS = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// Exact-match allowlist. Subdomain wildcards removed so a one-off
// `evil.mcpcentral.io` registration cannot bypass.
const ALLOWED_ORIGIN_HOSTS = new Set([
	'localhost',
	'127.0.0.1',
	'mcpcentral.io',
	'mcp.time.mcpcentral.io',
]);

const DEFAULT_FORMAT = 'YYYY-MM-DD HH:mm:ss';

// Treat invalid timezones as structured tool errors rather than
// silently producing "Invalid Date" strings. DateTimeFormat accepts
// common aliases (UTC/GMT/Zulu) that Intl.supportedValuesOf omits,
// so construct-and-catch is the authoritative check.
function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

// Read-only hints apply to every tool in this server.
const READ_ONLY_HINTS = {
	readOnlyHint: true,
	idempotentHint: true,
	openWorldHint: false,
} as const;

// Output schemas (used for both stdio outputSchema and HTTP tools/list).
const currentTimeOutput = z.object({
	utcTime: z.string(),
	localTime: z.string(),
	timezone: z.string(),
});
const relativeTimeOutput = z.object({ relativeTime: z.string() });
const daysInMonthOutput = z.object({ days: z.number().int() });
const timestampOutput = z.object({ timestamp: z.number() });
const convertTimeOutput = z.object({
	convertedTime: z.string(),
	hourDifference: z.number(),
});
const weekYearOutput = z.object({
	week: z.number().int(),
	isoWeek: z.number().int(),
});

type ToolResult = {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

function ok(data: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
		structuredContent: data,
		isError: false,
	};
}

function err(message: string): ToolResult {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
	};
}

function sanitize(e: unknown): string {
	if (e instanceof Error) return e.message.slice(0, 200);
	return 'Internal error';
}

// Single source of truth: each entry drives stdio registration and
// HTTP tools/list + tools/call dispatch.
type ToolDef = {
	name: string;
	title: string;
	description: string;
	inputShape: ZodRawShape;
	outputSchema: z.ZodObject<any>;
	annotations: typeof READ_ONLY_HINTS;
	handler: (args: any) => Promise<ToolResult>;
};

const TOOLS: ToolDef[] = [
	{
		name: 'current_time',
		title: 'Get Current Time',
		description: 'Returns the current time in UTC and a specified or guessed IANA timezone.',
		inputShape: {
			format: z
				.string()
				.optional()
				.describe('Format for the returned time string (default YYYY-MM-DD HH:mm:ss)'),
			timezone: z
				.string()
				.optional()
				.describe('IANA timezone name (e.g., "America/New_York"). Defaults to the server\'s guessed timezone'),
		},
		outputSchema: currentTimeOutput,
		annotations: READ_ONLY_HINTS,
		async handler(args: { format?: string; timezone?: string }) {
			const tz = args.timezone ?? dayjs.tz.guess();
			if (args.timezone && !isValidTimezone(args.timezone)) {
				return err(`Invalid IANA timezone: ${args.timezone}`);
			}
			const utcNow = dayjs.utc();
			const local = utcNow.tz(tz);
			const fmt = args.format ?? DEFAULT_FORMAT;
			return ok({
				utcTime: utcNow.format(fmt),
				localTime: local.format(fmt),
				timezone: tz,
			});
		},
	},
	{
		name: 'relative_time',
		title: 'Get Relative Time',
		description: 'Calculates the relative time from now to a given date-time string.',
		inputShape: {
			time: z.string().describe('The time to compare (format: YYYY-MM-DD HH:mm:ss)'),
		},
		outputSchema: relativeTimeOutput,
		annotations: READ_ONLY_HINTS,
		async handler(args: { time: string }) {
			// Parse bare strings as UTC for deterministic results across
			// deployments. Clients needing local semantics should call
			// convert_time first or pass an offset/TZ-aware string.
			const parsed = dayjs.utc(args.time);
			if (!parsed.isValid()) return err(`Invalid date-time: ${args.time}`);
			return ok({ relativeTime: parsed.fromNow() });
		},
	},
	{
		name: 'days_in_month',
		title: 'Get Days in Month',
		description: 'Returns the number of days in the month of a given date.',
		inputShape: {
			date: z
				.string()
				.optional()
				.describe('The date to check (format: YYYY-MM-DD). Defaults to current date'),
		},
		outputSchema: daysInMonthOutput,
		annotations: READ_ONLY_HINTS,
		async handler(args: { date?: string }) {
			const parsed = args.date ? dayjs.utc(args.date) : dayjs.utc();
			if (args.date && !parsed.isValid()) return err(`Invalid date: ${args.date}`);
			return ok({ days: parsed.daysInMonth() });
		},
	},
	{
		name: 'get_timestamp',
		title: 'Get Unix Timestamp',
		description: 'Converts a date-time string to a Unix timestamp in milliseconds.',
		inputShape: {
			time: z
				.string()
				.optional()
				.describe('The time to convert (format: YYYY-MM-DD HH:mm:ss). Defaults to current time'),
		},
		outputSchema: timestampOutput,
		annotations: READ_ONLY_HINTS,
		async handler(args: { time?: string }) {
			const parsed = args.time ? dayjs.utc(args.time) : dayjs.utc();
			if (args.time && !parsed.isValid()) return err(`Invalid date-time: ${args.time}`);
			return ok({ timestamp: parsed.valueOf() });
		},
	},
	{
		name: 'convert_time',
		title: 'Convert Timezone',
		description: 'Converts a time from a source IANA timezone to a target IANA timezone.',
		inputShape: {
			time: z.string().describe('The time to convert (e.g., "2025-03-23 12:30:00")'),
			sourceTimezone: z.string().describe('Source IANA timezone name (e.g., "Asia/Shanghai")'),
			targetTimezone: z.string().describe('Target IANA timezone name (e.g., "Europe/London")'),
		},
		outputSchema: convertTimeOutput,
		annotations: READ_ONLY_HINTS,
		async handler(args: { time: string; sourceTimezone: string; targetTimezone: string }) {
			if (!isValidTimezone(args.sourceTimezone)) {
				return err(`Invalid source timezone: ${args.sourceTimezone}`);
			}
			if (!isValidTimezone(args.targetTimezone)) {
				return err(`Invalid target timezone: ${args.targetTimezone}`);
			}
			const source = dayjs.tz(args.time, args.sourceTimezone);
			if (!source.isValid()) return err(`Invalid date-time: ${args.time}`);
			const target = source.tz(args.targetTimezone);
			const hoursDiff = Math.round((target.utcOffset() - source.utcOffset()) / 60);
			return ok({
				convertedTime: target.format(DEFAULT_FORMAT),
				hourDifference: hoursDiff,
			});
		},
	},
	{
		name: 'get_week_year',
		title: 'Get Week of Year',
		description: 'Returns the week number and ISO week number for a given date.',
		inputShape: {
			date: z
				.string()
				.optional()
				.describe('The date to check (e.g., "2025-03-23"). Defaults to current date'),
		},
		outputSchema: weekYearOutput,
		annotations: READ_ONLY_HINTS,
		async handler(args: { date?: string }) {
			const parsed = args.date ? dayjs.utc(args.date) : dayjs.utc();
			if (args.date && !parsed.isValid()) return err(`Invalid date: ${args.date}`);
			return ok({ week: parsed.week(), isoWeek: parsed.isoWeek() });
		},
	},
];

// ---- stdio mode: McpServer registration ----

function buildServer(): McpServer {
	const srv = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
	const register = (srv as any).registerTool.bind(srv);
	for (const t of TOOLS) {
		register(
			t.name,
			{
				title: t.title,
				description: t.description,
				inputSchema: t.inputShape,
				outputSchema: t.outputSchema.shape,
				annotations: t.annotations,
			},
			async (args: any) => t.handler(args)
		);
	}
	return srv;
}

// ---- HTTP mode (Streamable HTTP-lite) ----

function listTools() {
	return TOOLS.map((t) => ({
		name: t.name,
		title: t.title,
		description: t.description,
		inputSchema: zodToJsonSchema(z.object(t.inputShape)) as Record<string, unknown>,
		outputSchema: zodToJsonSchema(t.outputSchema) as Record<string, unknown>,
		annotations: t.annotations,
	}));
}

function isValidOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		return ALLOWED_ORIGIN_HOSTS.has(url.hostname);
	} catch {
		return false;
	}
}

function isSupportedProtocolVersion(version: string): boolean {
	return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

async function handleMcpRequest(request: any): Promise<any> {
	const { method, params, id } = request ?? {};

	switch (method) {
		case 'initialize': {
			const clientVersion: string | undefined = params?.protocolVersion;
			const responseVersion =
				clientVersion && isSupportedProtocolVersion(clientVersion)
					? clientVersion
					: LATEST_PROTOCOL_VERSION;
			return {
				jsonrpc: '2.0',
				id,
				result: {
					protocolVersion: responseVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
					instructions:
						'This MCP server provides time-related tools including current time, timezone conversion, relative time calculation, week number, and more.',
				},
			};
		}

		case 'tools/list':
			return { jsonrpc: '2.0', id, result: { tools: listTools() } };

		case 'tools/call': {
			const name: string | undefined = params?.name;
			const tool = TOOLS.find((t) => t.name === name);
			if (!tool) {
				return {
					jsonrpc: '2.0',
					id,
					error: { code: -32602, message: `Unknown tool: ${name}` },
				};
			}
			const schema = z.object(tool.inputShape);
			const parsed = schema.safeParse(params?.arguments ?? {});
			if (!parsed.success) {
				const issues = parsed.error.issues
					.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
					.join('; ');
				return {
					jsonrpc: '2.0',
					id,
					result: {
						content: [{ type: 'text', text: `Invalid arguments: ${issues}` }],
						isError: true,
					},
				};
			}
			try {
				const result = await tool.handler(parsed.data);
				return { jsonrpc: '2.0', id, result };
			} catch (e) {
				console.error('Tool execution error:', e);
				return {
					jsonrpc: '2.0',
					id,
					result: {
						content: [{ type: 'text', text: `Tool execution error: ${sanitize(e)}` }],
						isError: true,
					},
				};
			}
		}

		case 'ping':
			return { jsonrpc: '2.0', id, result: {} };

		case 'notifications/initialized':
		case 'initialized':
			return null;

		default:
			return {
				jsonrpc: '2.0',
				id,
				error: { code: -32601, message: `Method not found: ${method}` },
			};
	}
}

function corsHeaders(origin: string | null): Record<string, string> {
	const base: Record<string, string> = {
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Origin',
		'Access-Control-Expose-Headers': 'Mcp-Session-Id',
		Vary: 'Origin',
	};
	if (origin && isValidOrigin(origin)) {
		base['Access-Control-Allow-Origin'] = origin;
	}
	return base;
}

function json(data: unknown, status: number, headers: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	});
}

export default {
	async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
		const origin = request.headers.get('Origin');

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(origin) });
		}

		// Spec 2025-11-25 §Transports: "Server MUST validate Origin header on all
		// incoming connections." CLI/stdio-like clients send no Origin header at all
		// and are allowed through; browser-origin requests must match the allowlist.
		if (origin && !isValidOrigin(origin)) {
			return json(
				{ jsonrpc: '2.0', error: { code: -32600, message: 'Forbidden origin' }, id: null },
				403,
				corsHeaders(origin)
			);
		}

		const protocolVersion = request.headers.get('MCP-Protocol-Version');
		if (protocolVersion && !isSupportedProtocolVersion(protocolVersion)) {
			return json(
				{
					jsonrpc: '2.0',
					error: {
						code: -32602,
						message: 'Unsupported protocol version',
						data: {
							supported: SUPPORTED_PROTOCOL_VERSIONS,
							requested: protocolVersion,
						},
					},
					id: null,
				},
				400,
				corsHeaders(origin)
			);
		}

		if (request.method === 'POST') {
			let body: unknown;
			try {
				body = JSON.parse(await request.text());
			} catch {
				return json(
					{ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
					400,
					corsHeaders(origin)
				);
			}

			try {
				const mcpResponse = await handleMcpRequest(body);
				if (mcpResponse === null) {
					return new Response(null, { status: 202, headers: corsHeaders(origin) });
				}
				return json(mcpResponse, 200, corsHeaders(origin));
			} catch (e) {
				console.error('MCP handler error:', e);
				return json(
					{
						jsonrpc: '2.0',
						error: { code: -32603, message: 'Internal server error' },
						id: null,
					},
					500,
					corsHeaders(origin)
				);
			}
		}

		// Streamable HTTP allows 405 when server does not implement GET SSE.
		return new Response('Method not allowed', { status: 405, headers: corsHeaders(origin) });
	},
};

// ---- stdio mode ----

async function runStdio() {
	const srv = buildServer();
	const transport = new StdioServerTransport();
	await srv.connect(transport);
	console.error('MCP Time Server running on stdio');
	await new Promise<void>((resolve) => {
		transport.onclose = () => {
			console.error('Transport closed');
			resolve();
		};
		process.on('SIGINT', () => {
			console.error('Received SIGINT, shutting down');
			resolve();
		});
		process.on('SIGTERM', () => {
			console.error('Received SIGTERM, shutting down');
			resolve();
		});
	});
}

const isNodeCLI =
	typeof process !== 'undefined' &&
	process.argv &&
	process.stdin &&
	typeof process.stdin.on === 'function';

if (isNodeCLI) {
	runStdio().catch((error) => {
		console.error('Fatal error in stdio mode:', error);
		process.exit(1);
	});
}
