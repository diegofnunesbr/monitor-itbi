require('dotenv').config();
const { execSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');

const {
  PROCESS_NUMBER = '70-029.875/26-08',
  WHATSAPP_GROUP_ID,
  CRON_SCHEDULE = '0 * * * *',
} = process.env;

const CONSULTATION_URL = 'https://fazenda.pbh.gov.br/sigede/consulta/';
const API_URL = 'https://fazenda.pbh.gov.br/sigede/generico.asp';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Auto-detect system Chromium (more stable in WSL2/Linux than bundled Chrome)
function detectChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.platform !== 'linux') return undefined;
  try {
    return execSync('which chromium chromium-browser google-chrome 2>/dev/null | head -1', { encoding: 'utf8' }).trim() || undefined;
  } catch { return undefined; }
}

const CHROMIUM_PATH = detectChromium();

let lastStatus = null;
let waClient = null;
let isReady = false;

// ─── Scraper ─────────────────────────────────────────────────────────────────

async function fetchStatus() {
  try {
    // 1. GET the consultation page to obtain session cookies
    const { headers: h } = await axios.get(CONSULTATION_URL, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 20000,
    });
    const cookies = h['set-cookie']?.map(c => c.split(';')[0]).join('; ');

    // 2. POST to the internal API endpoint (triggered by blur event on the protocol input)
    const { data: html } = await axios.post(
      API_URL,
      new URLSearchParams({ tipo: 'G', protocolo: PROCESS_NUMBER, IC: '' }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
          'Referer': CONSULTATION_URL,
          ...(cookies ? { Cookie: cookies } : {}),
        },
        timeout: 20000,
      }
    );

    if (html.startsWith('Erro')) {
      console.error('[Scraper] Servidor retornou erro:', html.substring(5, 200));
      return null;
    }

    return parseProcessInfo(cheerio.load(html));
  } catch (err) {
    console.error('[Scraper] Erro:', err.message);
    return null;
  }
}

function parseProcessInfo($) {
  const info = { status: null, solicitacao: null, dataRecebimento: null, gerencia: null };

  // Solicitação: inside the active header list item
  info.solicitacao = $('.list-group-item.active strong').first().text()
    .replace(/^Solicitação:\s*/i, '').trim() || null;

  // HTML structure: <strong>Label:</strong> VALUE <br/><br/> <strong>Next:</strong> ...
  // Get the text node immediately after each <strong>
  $('strong').each((_, el) => {
    const label = $(el).text().trim();
    const siblings = $(el).parent().contents();
    const strongIdx = siblings.index(el);

    // Walk siblings after this <strong> to find the first non-empty text node
    let value = null;
    for (let i = strongIdx + 1; i < siblings.length; i++) {
      const node = siblings[i];
      if (node.type === 'text') {
        const t = (node.data || '').trim();
        if (t) { value = t; break; }
      } else if (node.type === 'tag' && node.name !== 'br') {
        break; // hit another element
      }
    }

    if (!value) return;

    if (/Situa[çc][aã]o do processo/i.test(label)) info.status = value;
    if (/Data de recebimento/i.test(label)) info.dataRecebimento = value;
    if (/Ger[êe]ncia atual/i.test(label)) info.gerencia = value;
  });

  return info;
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

function initWhatsApp(onReady) {
  let readyFired = false;

  if (CHROMIUM_PATH) console.log(`[WhatsApp] Usando Chromium: ${CHROMIUM_PATH}`);

  waClient = new Client({
    authStrategy: new LocalAuth({ clientId: 'monitor-itbi' }),
    puppeteer: {
      headless: true,
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });

  waClient.on('qr', (qr) => {
    console.log('\n[WhatsApp] Escaneie o QR Code com seu celular:');
    qrcode.generate(qr, { small: true });
  });

  waClient.on('ready', () => {
    if (readyFired) return;
    readyFired = true;
    console.log('[WhatsApp] Conectado com sucesso!\n');
    isReady = true;
    onReady();
  });

  waClient.on('auth_failure', () => {
    console.error('[WhatsApp] Falha de autenticação. Delete a pasta .wwebjs_auth e tente novamente.');
    process.exit(1);
  });

  waClient.on('disconnected', (reason) => {
    console.warn('[WhatsApp] Desconectado:', reason);
    isReady = false;
  });

  waClient.initialize();
}

async function sendMessage(text) {
  if (!isReady || !waClient) {
    console.warn('[WhatsApp] Cliente não está pronto, mensagem não enviada.');
    return;
  }
  if (!WHATSAPP_GROUP_ID) {
    console.log('[WhatsApp] WHATSAPP_GROUP_ID não configurado — exibindo mensagem no console:\n');
    console.log(text);
    return;
  }
  await waClient.sendMessage(WHATSAPP_GROUP_ID, text);
  console.log('[WhatsApp] Mensagem enviada.');
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

async function checkAndNotify() {
  console.log(`[Monitor] ${new Date().toLocaleString('pt-BR')} — verificando processo ${PROCESS_NUMBER}...`);

  const info = await fetchStatus();

  if (!info || !info.status) {
    console.warn('[Monitor] Não foi possível obter o status. Tentará novamente no próximo ciclo.');
    await sendMessage(`⚠️ *Monitor ITBI*\nNão foi possível verificar o processo ${PROCESS_NUMBER} agora. Tentarei novamente em 1 hora.`);
    return;
  }

  console.log('[Monitor] Status atual:', info.status);

  const statusChanged = lastStatus !== null && lastStatus !== info.status;

  let msg = formatMessage(info);
  if (statusChanged) {
    msg = `🔔 *MUDANÇA DE STATUS DETECTADA!*\n\nAnterior: ${lastStatus}\n\n${msg}`;
    console.log('[Monitor] Status mudou de', lastStatus, 'para', info.status);
  }

  await sendMessage(msg);
  lastStatus = info.status;
}

function formatMessage(info) {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const lines = [
    `📋 *Consulta ITBI — PBH*`,
    `Processo: \`${PROCESS_NUMBER}\``,
    ``,
  ];
  if (info.solicitacao) lines.push(`Solicitação: ${info.solicitacao}`);
  if (info.dataRecebimento) lines.push(`Recebimento: ${info.dataRecebimento}`);
  lines.push(`*Situação: ${info.status}*`);
  if (info.gerencia) lines.push(`Gerência: ${info.gerencia}`);
  lines.push(``, `🕐 Verificado em: ${now}`);
  return lines.join('\n');
}

function startMonitoring() {
  console.log(`[Monitor] Agendamento: "${CRON_SCHEDULE}" (America/Sao_Paulo)`);
  console.log('[Monitor] Executando verificação inicial...\n');

  checkAndNotify();

  cron.schedule(CRON_SCHEDULE, checkAndNotify, { timezone: 'America/Sao_Paulo' });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--test-scrape')) {
  console.log(`[Teste] Consultando processo: ${PROCESS_NUMBER}\n`);
  fetchStatus().then(info => {
    console.log('Resultado:');
    console.log(JSON.stringify(info, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });

} else if (args.includes('--list-groups')) {
  console.log('[WhatsApp] Iniciando para listar grupos...');
  initWhatsApp(async () => {
    const chats = await waClient.getChats();
    const groups = chats.filter(c => c.isGroup);
    console.log(`\n=== ${groups.length} grupo(s) encontrado(s) ===\n`);
    groups.forEach(g => {
      console.log(`Nome : ${g.name}`);
      console.log(`ID   : ${g.id._serialized}`);
      console.log('─'.repeat(50));
    });
    process.exit(0);
  });

} else {
  if (!WHATSAPP_GROUP_ID) {
    console.warn('[Aviso] WHATSAPP_GROUP_ID não definido no .env');
    console.warn('        Execute "npm run list-groups" para encontrar o ID do grupo.\n');
  }
  initWhatsApp(startMonitoring);
}
