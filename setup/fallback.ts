#!/usr/bin/env -S pnpm exec tsx

import { spawnSync } from 'child_process';
import fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brightSelect } from './lib/bright-select.js';
import { ensureAnswer } from './lib/runner.js';
import { brandBody } from './lib/theme.js';

const ENV_PATH = path.join(process.cwd(), '.env');
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OLLAMA_DEFAULT_URL = 'http://host.docker.internal:11434';

const HARDCODED_TOP_MODELS = [
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'openai/o4-mini',
  'openai/gpt-5.2-pro',
  'anthropic/claude-sonnet-4.5',
  'deepseek/deepseek-v4-pro',
  'meta-llama/llama-4-maverick',
  'qwen/qwen3-coder',
  'mistralai/mistral-large-3',
  'x-ai/grok-code-fast-1',
  'cohere/command-a-2026',
  'amazon/nova-pro-v1',
  'google/gemini-3-pro',
  'openai/gpt-5.2',
  'anthropic/claude-opus-4.5',
];

interface EnvConfig {
  FALLBACK_PROVIDER?: string;
  OPENCODE_PROVIDER?: string;
  OPENCODE_MODEL?: string;
  OLLAMA_BASE_URL?: string;
  OLLAMA_MODEL?: string;
}

function readEnvFile(): EnvConfig {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const config: EnvConfig = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case 'FALLBACK_PROVIDER': config.FALLBACK_PROVIDER = value; break;
      case 'OPENCODE_PROVIDER': config.OPENCODE_PROVIDER = value; break;
      case 'OPENCODE_MODEL': config.OPENCODE_MODEL = value; break;
      case 'OLLAMA_BASE_URL': config.OLLAMA_BASE_URL = value; break;
      case 'OLLAMA_MODEL': config.OLLAMA_MODEL = value; break;
    }
  }
  return config;
}

function writeEnvLine(key: string, value: string): void {
  const content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$`, 'm');
  const next = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(ENV_PATH, next);
}

function removeEnvLine(key: string): void {
  if (!fs.existsSync(ENV_PATH)) return;
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$\\n?`, 'm');
  fs.writeFileSync(ENV_PATH, content.replace(re, ''));
}

function logConfigEvent(msg: string): void {
  const dir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(path.join(dir, 'fallback-setup.log'), entry);
}

function onecliAvailable(): boolean {
  try {
    return spawnSync('onecli', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function saveSecretToVault(name: string, type: string, value: string, hostPattern: string, headerName?: string, valueFormat?: string): boolean {
  const args = ['secrets', 'create', '--name', name, '--type', type, '--value', value, '--host-pattern', hostPattern];
  if (headerName) args.push('--header-name', headerName);
  if (valueFormat) args.push('--value-format', valueFormat);
  const res = spawnSync('onecli', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return res.status === 0;
}

function httpGetJson(url: string, timeout = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchTopModels(): Promise<{ id: string; name: string; context_length: number }[]> {
  try {
    const data = await httpGetJson(OPENROUTER_MODELS_URL, 10000) as { data?: { id: string; name?: string; context_length?: number }[] };
    if (!data?.data || !Array.isArray(data.data)) throw new Error('Invalid response');

    const models = data.data
      .filter((m) => m.id && m.name)
      .map((m) => ({ id: m.id, name: m.name!, context_length: m.context_length ?? 0 }))
      .slice(0, 15);

    if (models.length === 0) throw new Error('Empty model list');
    return models;
  } catch (err) {
    p.log.warn(k.yellow('OpenRouter API unreachable. Showing hardcoded list.'));
    return HARDCODED_TOP_MODELS.map((id) => ({ id, name: id, context_length: 0 }));
  }
}

async function verifyOpenRouterModel(modelId: string): Promise<boolean> {
  try {
    const resp = await httpGetJson(`https://openrouter.ai/api/v1/models/${modelId}`, 8000) as { data?: { id: string } };
    return !!(resp?.data?.id);
  } catch {
    return false;
  }
}

async function discoverOllamaModels(baseUrl: string): Promise<string[] | null> {
  try {
    const url = `${baseUrl}/api/tags`;
    const data = await httpGetJson(url, 5000) as { models?: { name: string }[] };
    return data.models?.map((m) => m.name) ?? null;
  } catch {
    return null;
  }
}

function printBanner(): void {
  console.log();
  console.log(k.bold(k.blue('  \u26a1 Backup Provider Setup')));
  console.log(k.dim('  When Claude runs out of credits or gets overloaded, the system'));
  console.log(k.dim('  automatically switches to the backup provider you choose here.'));
  console.log();
}

function printCurrentConfig(curr: EnvConfig): void {
  if (!curr.FALLBACK_PROVIDER) return;
  console.log(k.bold('  Current config:'));
  console.log(k.cyan(`  Provider:  ${curr.FALLBACK_PROVIDER}`));
  if (curr.OPENCODE_MODEL) console.log(k.cyan(`  Model:     ${curr.OPENCODE_MODEL} (via ${curr.OPENCODE_PROVIDER || 'openrouter'})`));
  if (curr.OLLAMA_MODEL) {
    console.log(k.cyan(`  Model:     ${curr.OLLAMA_MODEL}`));
    if (curr.OLLAMA_BASE_URL) console.log(k.cyan(`  URL:       ${curr.OLLAMA_BASE_URL}`));
  }
  console.log();
}

export async function runFallbackWizard(): Promise<void> {
  printBanner();

  const current = readEnvFile();

  if (current.FALLBACK_PROVIDER) {
    printCurrentConfig(current);
    const change = await p.confirm({
      message: 'Would you like to change the backup configuration?',
      initialValue: false,
    });
    if (p.isCancel(change) || change === false) {
      p.log.info(brandBody('Backup config left unchanged.'));
      return;
    }
  }

  const choice = ensureAnswer(
    await brightSelect<'opencode' | 'ollama' | 'none'>({
      message: 'Which backup provider should take over when Claude hits its limits?',
      options: [
        { value: 'opencode', label: 'OpenCode + OpenRouter', hint: 'recommended' },
        { value: 'ollama', label: 'Ollama (local model)' },
        { value: 'none', label: 'No backup' },
      ],
    }),
  );

  if (choice === 'none') {
    for (const key of ['FALLBACK_PROVIDER', 'OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL']) {
      removeEnvLine(key);
    }
    logConfigEvent('No backup configured');
    p.log.info(brandBody('OK. When Claude hits a limit, you\u2019ll get a reminder to set up a backup.'));
    return;
  }

  if (choice === 'opencode') {
    await setupOpenCode(current);
  } else if (choice === 'ollama') {
    await setupOllama(current);
  }
}

async function setupOpenCode(current: EnvConfig): Promise<void> {
  const s = p.spinner();
  s.start('Loading top models from OpenRouter\u2026');
  const models = await fetchTopModels();
  s.stop('Models loaded.');

  const modelOptions = [
    ...models.map((m) => ({
      value: m.id,
      label: m.id,
      hint: m.context_length ? `${Math.round(m.context_length / 1024)}k context` : undefined,
    })),
    { value: '__custom__', label: 'Other\u2026 (enter ID manually)', hint: 'verified against OpenRouter' },
  ];

  const pick = ensureAnswer(
    await brightSelect<string>({
      message: 'Choose a backup model on OpenRouter:',
      options: modelOptions,
      initialValue: current.OPENCODE_MODEL && modelOptions.some((m) => m.value === current.OPENCODE_MODEL)
        ? (current.OPENCODE_MODEL as string)
        : models[0]?.id,
    }),
  );

  let chosenModel: string | null = null;

  if (pick === '__custom__') {
    while (!chosenModel) {
      const customRaw = await p.text({
        message: 'Enter the model ID on OpenRouter (e.g. openai/gpt-4o):',
        placeholder: 'provider/model-name',
      });
      if (p.isCancel(customRaw)) return;
      const id = (customRaw as string).trim();
      if (!id || !id.includes('/')) {
        p.log.warn(k.yellow('Required format: provider/model-name (e.g. openai/gpt-4o)'));
        continue;
      }

      const vs = p.spinner();
      vs.start(`Verifying "${id}" on OpenRouter\u2026`);
      const exists = await verifyOpenRouterModel(id);
      if (exists) {
        vs.stop('Model verified.');
        chosenModel = id;
      } else {
        vs.stop(`Model "${id}" does not exist on OpenRouter.`);
        const retry = await p.confirm({ message: 'Try another ID?', initialValue: true });
        if (p.isCancel(retry) || !retry) return;
      }
    }
  } else {
    chosenModel = pick;
  }

  if (!chosenModel) return;

  const keyRaw = await p.password({
    message: 'Paste your OpenRouter API key:',
  });
  if (p.isCancel(keyRaw)) return;
  const apiKey = (keyRaw as string).trim();

  if (onecliAvailable()) {
    const ss = p.spinner();
    ss.start('Saving key to OneCLI vault\u2026');
    if (saveSecretToVault('OpenRouter', 'generic', apiKey, 'openrouter.ai', 'Authorization', 'Bearer {value}')) {
      ss.stop('Key saved to OneCLI vault.');
      logConfigEvent('OpenRouter API key saved to OneCLI vault');
    } else {
      ss.stop(k.yellow('OneCLI could not accept the key.'));
      fallbackPlaintextSave(apiKey, chosenModel);
      return;
    }
  } else {
    p.log.warn(k.yellow('OneCLI not available. Key will be saved in plaintext.'));
    fallbackPlaintextSave(apiKey, chosenModel);
    return;
  }

  writeEnvLine('FALLBACK_PROVIDER', 'opencode');
  writeEnvLine('OPENCODE_PROVIDER', 'openrouter');
  writeEnvLine('OPENCODE_MODEL', chosenModel);

  if (current.FALLBACK_PROVIDER === 'ollama') {
    removeEnvLine('OLLAMA_BASE_URL');
    removeEnvLine('OLLAMA_MODEL');
  }

  logConfigEvent(`Fallback configured: opencode + openrouter, model=${chosenModel}`);
  p.log.success(k.green(`Backup configured: OpenCode + OpenRouter with model ${chosenModel}.`));
}

function fallbackPlaintextSave(apiKey: string, chosenModel: string): void {
  p.log.warn(k.yellow('\u26a0\ufe0f  OneCLI unavailable. The key has been saved in plaintext in .env.'));
  p.log.warn(k.dim('   Run OneCLI setup and redo the fallback configuration for better security.'));

  writeEnvLine('FALLBACK_PROVIDER', 'opencode');
  writeEnvLine('OPENCODE_PROVIDER', 'openrouter');
  writeEnvLine('OPENCODE_MODEL', chosenModel);
  writeEnvLine('OPENROUTER_API_KEY', apiKey);

  logConfigEvent(`Fallback configured (plaintext key): opencode + openrouter, model=${chosenModel}`);
}

async function setupOllama(current: EnvConfig): Promise<void> {
  const defaultUrl = current.OLLAMA_BASE_URL || OLLAMA_DEFAULT_URL;
  const urlRaw = await p.text({
    message: 'Ollama daemon URL:',
    placeholder: defaultUrl,
    defaultValue: defaultUrl,
  });
  if (p.isCancel(urlRaw)) return;
  const baseUrl = (urlRaw as string).trim().replace(/\/+$/, '') || defaultUrl;

  let chosenModel: string | null = null;

  const s = p.spinner();
  s.start('Looking for local Ollama models\u2026');
  const discovered = await discoverOllamaModels(baseUrl);
  if (discovered && discovered.length > 0) {
    s.stop(`Found ${discovered.length} model(s).`);
  } else {
    s.stop('No local models found.');
  }

  if (discovered && discovered.length > 0) {
    const modelOptions = [
      ...discovered.map((m) => ({ value: m, label: m })),
      { value: '__manual__', label: 'Other\u2026 (enter ID manually)' },
    ];
    const pick = ensureAnswer(
      await brightSelect<string>({
        message: 'Choose an Ollama model as backup:',
        options: modelOptions,
        initialValue: current.OLLAMA_MODEL && discovered.includes(current.OLLAMA_MODEL)
          ? current.OLLAMA_MODEL
          : discovered[0],
      }),
    );
    if (pick === '__manual__') {
      chosenModel = await askOllamaManualModel();
    } else {
      chosenModel = pick;
    }
  } else {
    chosenModel = await askOllamaManualModel();
  }

  if (!chosenModel) return;

  writeEnvLine('FALLBACK_PROVIDER', 'ollama');
  writeEnvLine('OLLAMA_BASE_URL', baseUrl);
  writeEnvLine('OLLAMA_MODEL', chosenModel);

  if (current.FALLBACK_PROVIDER === 'opencode') {
    removeEnvLine('OPENCODE_PROVIDER');
    removeEnvLine('OPENCODE_MODEL');
    removeEnvLine('OPENROUTER_API_KEY');
  }

  logConfigEvent(`Fallback configured: ollama, model=${chosenModel}, url=${baseUrl}`);
  p.log.success(k.green(`Backup configured: Ollama with model ${chosenModel} at ${baseUrl}.`));
  p.log.info(k.dim('  Make sure the Ollama daemon is running. If the model hasn\u2019t been pulled yet,'));
  p.log.info(k.dim(`  Ollama will download it automatically: ollama pull ${chosenModel}`));
}

async function askOllamaManualModel(): Promise<string | null> {
  const input = await p.text({
    message: 'Enter the Ollama model ID (e.g. gemma4:latest):',
    placeholder: 'gemma4:latest',
  });
  if (p.isCancel(input)) return null;
  return (input as string).trim() || null;
}

const invokedDirectly = process.argv[1]?.includes('fallback');
if (invokedDirectly) {
  runFallbackWizard().catch((err) => {
    console.error(k.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}
