// index.js
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const XLSX = require('xlsx');

const app = express();
app.use(bodyParser.json());

// === CONFIG via ENV VARS (configure antes de rodar) ===
// Z-API
const ZAPI_BASE = process.env.ZAPI_BASE || 'https://api.z-api.io';
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE; // ex: instance id
const ZAPI_TOKEN = process.env.ZAPI_TOKEN; // token fornecido pelo Z-API

// ADMIN (seu número completo com DDI, ex: 5511999999999)
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '';

// MAPEAMENTO unidades -> arquivo Excel (link de download direto)
 // formato JSON em variável de ambiente FILE_URLS:
 // {"PERG":"https://drive.google.com/uc?export=download&id=ID1","PMEI":"https://drive.google.com/uc?export=download&id=ID2"}
const FILE_URLS = process.env.FILE_URLS ? JSON.parse(process.env.FILE_URLS) : {};

// Tempo de timeout para inatividade em ms (ex: 15 minutos)
const INACTIVITY_TIMEOUT_MS = parseInt(process.env.INACTIVITY_TIMEOUT_MS || String(15 * 60 * 1000), 10);

// Link do site de pedidos (quando clicar no botão)
const SITE_LINK = process.env.SITE_LINK || 'https://seudominio.com';

// catálogo PDF/URL (opcional)
const CATALOGUE_URL = process.env.CATALOGUE_URL || 'https://link-do-catalogo.pdf';

// porta
const PORT = process.env.PORT || 3000;

// Estado de sessão por telefone (map phone -> session)
const sessions = new Map();

// util helpers for Z-API calls
function zapiUrl(path) {
  if (!ZAPI_INSTANCE || !ZAPI_TOKEN) throw new Error('ZAPI_INSTANCE and ZAPI_TOKEN must be set');
  // exemplo: https://api.z-api.io/instances/<ID>/token/<TOKEN>/<path>
  return `${ZAPI_BASE}/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/${path}`;
}

async function sendText(phone, message) {
  const url = zapiUrl('sendText');
  const body = { phone, message };
  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }
  });
  return res.json();
}

async function sendButtons(phone, text, buttons) {
  // buttons: array of { title, id } or simple text list suitable to your Z-API method
  // We'll send a "simple" text with numbered options for compatibility and also send a list interactive.
  // First try list message (if Z-API supports). If not, fallback to plain text with enumerated options.
  try {
    const url = zapiUrl('sendInteractiveList');
    // build minimal structure expected
    const sections = [{ title: 'Opções', rows: buttons.map((b, i) => ({ id: b.id || String(i+1), title: b.title })) }];
    const body = {
      phone,
      message: text,
      buttonText: 'Escolher',
      sections
    };
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const json = await res.json();
    return json;
  } catch (err) {
    // fallback to plain enumerated text
    const list = buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
    return sendText(phone, `${text}\n\n${list}`);
  }
}

// fetch and parse Excel file from a URL (Google Drive direct download)
async function fetchWorkbookFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Erro ao baixar planilha: ${r.status}`);
  const buffer = await r.buffer();
  const wb = XLSX.read(buffer, { type: 'buffer' });
  return wb;
}

// sanitize sheet name to match your tab naming
function sanitizeName(name) {
  return name.trim(); // adjust if you normalize underscores, etc.
}

// parse a customer sheet into an object (expect key-value layout)
function parseCustomerSheet(sheet) {
  const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  // assume first column keys and second column values OR table headers; we'll handle simple patterns:
  const result = {
    name: '',
    cpf: '',
    dividas: [],
    vales: [],
    haveres: []
  };

  // try to detect key:value lines
  for (let r of json) {
    if (!r || r.length < 2) continue;
    const key = String(r[0]).toLowerCase().trim();
    const val = r[1];

    if (key.includes('nome')) result.name = String(val || '').trim();
    else if (key.includes('cpf')) result.cpf = String(val || '').trim();
    else if (key.includes('dívida') || key.includes('divida') || key.includes('dividas')) {
      // if value contains multiple, split by ; or |
      if (typeof val === 'string' && (val.includes(';') || val.includes('|'))) {
        const parts = val.split(/;|\|/).map(s => s.trim()).filter(Boolean);
        for (let p of parts) result.dividas.push(p);
      } else {
        result.dividas.push(String(val).trim());
      }
    } else if (key.includes('vale')) {
      // similar handling
      if (typeof val === 'string' && (val.includes(';') || val.includes('|'))) {
        const parts = val.split(/;|\|/).map(s => s.trim()).filter(Boolean);
        for (let p of parts) result.vales.push(p);
      } else {
        result.vales.push(String(val).trim());
      }
    } else if (key.includes('haver')) {
      if (typeof val === 'string' && (val.includes(';') || val.includes('|'))) {
        const parts = val.split(/;|\|/).map(s => s.trim()).filter(Boolean);
        for (let p of parts) result.haveres.push(p);
      } else {
        result.haveres.push(String(val).trim());
      }
    } else {
      // store other rows with heuristics: if first cell is like 'Haver 1' or 'Vale 1'
      if (/^haver/i.test(key)) result.haveres.push(String(val).trim());
      else if (/^vale/i.test(key)) result.vales.push(String(val).trim());
      else if (/^divida/i.test(key) || /^dívida/i.test(key)) result.dividas.push(String(val).trim());
    }
  }

  // If all empty, attempt to parse as header table: search for columns
  if (result.name === '' && result.cpf === '' && result.dividas.length === 0 && result.vales.length === 0 && json.length > 0) {
    // try headers mode: first row headers, following rows data
    const headers = json[0].map(h => String(h).toLowerCase());
    for (let i = 1; i < json.length; i++) {
      const row = json[i];
      if (!row) continue;
      const rowObj = {};
      for (let c = 0; c < headers.length; c++) {
        rowObj[headers[c]] = row[c];
      }
      if (rowObj.nome || rowObj.name) {
        if (rowObj.nome) result.name = String(rowObj.nome).trim();
        if (rowObj.cpf) result.cpf = String(rowObj.cpf).trim();
        if (rowObj.divida || rowObj.dividas) result.dividas.push(String(rowObj.divida || rowObj.dividas || '').trim());
        if (rowObj.vale || rowObj.vales) result.vales.push(String(rowObj.vale || rowObj.vales || '').trim());
        if (rowObj.haver || rowObj.haveres) result.haveres.push(String(rowObj.haver || rowObj.haveres || '').trim());
      }
    }
  }

  return result;
}

// find customer sheet given workbook and name or cpf
function findCustomerInWorkbook(wb, identifier) {
  // identifier can be CPF or name
  const sheetNames = wb.SheetNames;
  // try exact match first
  if (sheetNames.includes(identifier)) {
    return { sheet: wb.Sheets[identifier], sheetName: identifier };
  }
  // try sanitized match
  const sanitized = sanitizeName(identifier);
  const foundByName = sheetNames.find(s => s.toLowerCase() === sanitized.toLowerCase());
  if (foundByName) return { sheet: wb.Sheets[foundByName], sheetName: foundByName };

  // else attempt to scan each sheet for matching CPF or name cell
  for (let s of sheetNames) {
    const sh = wb.Sheets[s];
    const txt = XLSX.utils.sheet_to_csv(sh).toLowerCase();
    if (txt.includes(identifier.toLowerCase().replace(/\D/g, ''))) {
      return { sheet: sh, sheetName: s };
    }
    if (txt.includes(identifier.toLowerCase())) {
      return { sheet: sh, sheetName: s };
    }
  }
  return null;
}

// Build the reply text from parsed customer object
function buildCustomerReply(unit, customer) {
  let out = `Unidade: ${unit}\n`;
  out += `Nome: ${customer.name || '—'}\n`;
  out += `CPF: ${customer.cpf || '—'}\n\n`;

  if (customer.dividas && customer.dividas.length) {
    out += 'Dívidas:\n';
    customer.dividas.forEach(d => {
      out += `• ${d}\n`;
    });
  } else out += 'Dívidas:\n• Nenhuma\n';

  out += '\n';

  if (customer.vales && customer.vales.length) {
    out += 'Vales em aberto:\n';
    customer.vales.forEach(v => out += `• ${v}\n`);
  } else out += 'Vales em aberto:\n• Nenhum\n';

  out += '\n';

  if (customer.haveres && customer.haveres.length) {
    out += 'Haveres:\n';
    customer.haveres.forEach(h => out += `• ${h}\n`);
  } else out += 'Haveres:\n• Nenhum\n';

  return out;
}

// === BOT FLOW HANDLERS ===

// initial menu (units)
const unitsButtons = [
  { id: 'PERG', title: 'PERG – Rio Grande' },
  { id: 'PMEI', title: 'PMEI – Ijuí' },
  { id: 'PETP', title: 'PETP – Três Passos' },
  { id: 'PEL', title: 'PEL – Lajeado' },
  { id: 'PRSA', title: 'PRSA – Santo Ângelo' },
  { id: 'PEV', title: 'PEV – Vacaria' },
  { id: 'PEC', title: 'PEC – Canela' }
];

function createSessionIfNot(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      phone,
      state: 'INIT', // or 'AWAIT_UNIT', 'AWAIT_OPTION', 'AWAIT_CPF', etc.
      unit: null,
      lastInteraction: Date.now(),
      timeoutHandle: null
    });
  }
  resetTimeout(phone);
}

function resetTimeout(phone) {
  const s = sessions.get(phone);
  if (!s) return;
  if (s.timeoutHandle) clearTimeout(s.timeoutHandle);
  s.timeoutHandle = setTimeout(() => {
    // inactivity fallback
    const fallbackMsg = 'Devido à falta de continuidade da conversa, estaremos te encaminhando para um dos nossos atendentes. Aguarde um instante, por favor.';
    sendText(phone, fallbackMsg).catch(console.error);
    // forward to admin
    sendText(ADMIN_WHATSAPP, `Cliente sem resposta: ${phone}\nÚltimo estado: ${s.state}`);
    s.state = 'AWAITING_HUMAN';
  }, INACTIVITY_TIMEOUT_MS);
  s.lastInteraction = Date.now();
}

// send initial menu
async function sendInitialMenu(phone) {
  createSessionIfNot(phone);
  const text = 'Olá! 👋\n\nEscolha a unidade que deseja atendimento:';
  // send interactive list if possible
  await sendButtons(phone, text, unitsButtons);
  const s = sessions.get(phone);
  s.state = 'AWAITING_UNIT';
}

// send unit menu
async function sendUnitMenu(phone, unit) {
  createSessionIfNot(phone);
  sessions.get(phone).unit = unit;
  sessions.get(phone).state = 'AWAITING_OPTION';
  const text = `Unidade: ${unit}\n\nComo posso ajudar?`;
  const buttons = [
    { id: 'FAZER_PEDIDO', title: 'Fazer pedido' },
    { id: 'CONSULTAR', title: 'Consultar vales, dívidas e pedidos' },
    { id: 'OUTROS', title: 'Outros' },
    { id: 'VOLTAR', title: 'Voltar ao menu principal' }
  ];
  await sendButtons(phone, text, buttons);
}

// send Fazer pedido menu
async function sendFazerPedidoMenu(phone) {
  createSessionIfNot(phone);
  sessions.get(phone).state = 'AWAITING_PEDIDO_METHOD';
  const text = 'Escolha como deseja fazer seu pedido:';
  const buttons = [
    { id: 'PEDIDO_SITE', title: 'Fazer pedido pelo site' },
    { id: 'PEDIDO_TEXTO', title: 'Continuar pedido por aqui' },
    { id: 'VOLTAR_MENU_UNIT', title: 'Voltar ao menu principal' }
  ];
  await sendButtons(phone, text, buttons);
}

// handle consult request: ask for name+cpf
async function askForNameCpf(phone) {
  createSessionIfNot(phone);
  sessions.get(phone).state = 'AWAITING_NAME_CPF';
  const text = 'Para consultar vales/haver, dívidas ou o status do seu pedido, envie:\n\nNome completo e CPF\n\nExemplo:\nJoão da Silva – 123.456.789-00';
  await sendText(phone, text);
}

// fallback unified handler
async function fallbackToHuman(phone) {
  const msg = 'Devido à falta de continuidade da conversa, estaremos te encaminhando para um dos nossos atendentes. Aguarde um instante, por favor.';
  await sendText(phone, msg);
  // forward context to admin
  const s = sessions.get(phone) || {};
  await sendText(ADMIN_WHATSAPP, `Encaminhando para atendimento humano. Cliente: ${phone}\nEstado: ${s.state}\nUnidade: ${s.unit || '—'}`);
  s.state = 'AWAITING_HUMAN';
}

// handle incoming parsed message payload
async function handleIncoming(phone, text, raw) {
  createSessionIfNot(phone);
  resetTimeout(phone);
  const s = sessions.get(phone);
  const lower = (text || '').toLowerCase().trim();

  // if initial greeting or unknown state, send initial menu
  if (!text) {
    await sendInitialMenu(phone);
    return;
  }

  // if waiting human, ignore
  if (s.state === 'AWAITING_HUMAN') {
    // already sent to human
    return;
  }

  // handle commands keyed by exact titles if interactive replies are used
  // try to match unit selection first
  const matchedUnit = unitsButtons.find(u => u.title.toLowerCase() === text.toLowerCase() || u.id.toLowerCase() === text.toLowerCase() || u.title.toLowerCase().startsWith(text.toLowerCase()));
  if (s.state === 'AWAITING_UNIT') {
    if (matchedUnit) {
      await sendUnitMenu(phone, matchedUnit.id);
      return;
    } else {
      // maybe user typed unit text; check numbers? fallback to send list again
      await sendInitialMenu(phone);
      return;
    }
  }

  // if awaiting option in unit menu
  if (s.state === 'AWAITING_OPTION') {
    if (text.toLowerCase().includes('fazer pedido') || text.toLowerCase().includes('pedido')) {
      await sendFazerPedidoMenu(phone);
      return;
    } else if (text.toLowerCase().includes('consultar') || text.toLowerCase().includes('vales') || text.toLowerCase().includes('dívidas')) {
      await askForNameCpf(phone);
      return;
    } else if (text.toLowerCase().includes('outros') || text.toLowerCase().includes('duvidas')) {
      // send Outros menu
      s.state = 'AWAITING_OUTROS';
      const textOut = 'Escolha uma das opções abaixo:';
      const buttons = [
        { id: 'PEDIDO_NAO_CHEGOU', title: 'Meu pedido não chegou' },
        { id: 'PEDIDO_INCOMPLETO', title: 'Meu pedido veio incompleto / itens errados' },
        { id: 'MODIFICAR_PEDIDO', title: 'Modificar pedido' },
        { id: 'CANCELAR_PEDIDO', title: 'Cancelar pedido' },
        { id: 'OUTRO_ATENDENTE', title: 'Outro (falar com atendente)' },
        { id: 'VOLTAR_MENU_UNIT', title: 'Voltar ao menu principal' }
      ];
      await sendButtons(phone, textOut, buttons);
      return;
    } else if (text.toLowerCase().includes('voltar')) {
      await sendInitialMenu(phone);
      return;
    } else {
      // unknown, resend unit menu
      await sendUnitMenu(phone, s.unit || '');
      return;
    }
  }

  // handle Fazer pedido substate
  if (s.state === 'AWAITING_PEDIDO_METHOD') {
    if (text.toLowerCase().includes('site') || text.toLowerCase().includes('fazer pedido pelo site') || text.toLowerCase().includes('pedido pelo site') || text.toLowerCase().includes('pedido pelo site')) {
      // send site link
      await sendText(phone, `Abra o link para fazer seu pedido: ${SITE_LINK}`);
      await sendUnitMenu(phone, s.unit);
      return;
    } else if (text.toLowerCase().includes('continuar') || text.toLowerCase().includes('texto') || text.toLowerCase().includes('continuar pedido')) {
      // send catalog and pix
      await sendText(phone, `Segue nosso catálogo: ${CATALOGUE_URL}\n\nChave PIX da unidade ${s.unit}: (COLOQUE_SUA_CHAVE_AQUI)\n\nExemplo de pedido:\n\nPenitenciária ${s.unit}\nMódulo/Pavilhão X, Galeria X, Cela X\nNome do detento: XXX\n\n1 coca cola\n1 sukita uva\n...\n\nAguardo sua lista + comprovante.`);
      await sendUnitMenu(phone, s.unit);
      return;
    } else if (text.toLowerCase().includes('voltar')) {
      await sendUnitMenu(phone, s.unit);
      return;
    } else {
      // fallback: user text not matching
      await fallbackToHuman(phone);
      return;
    }
  }

  // OUTROS menu handlers
  if (s.state === 'AWAITING_OUTROS') {
    if (text.toLowerCase().includes('não chegou') || text.toLowerCase().includes('nao chegou')) {
      // ask days of delivery (we'll just respond with placeholder)
      const reply = `As entregas nesta unidade seguem o seguinte cronograma:\n\n{{DIAS_DE_ENTREGA_DA_UNIDADE}}\n\nPedidos via WhatsApp têm prazo de 5 dias úteis para entrega.\nNão entregamos em dia de visita.\n\nSeu problema foi solucionado?`;
      await sendText(phone, reply);
      // set next state to check yes/no
      s.state = 'AWAITING_CONFIRM_ISSUE';
      s.lastIssue = 'PEDIDO_NAO_CHEGOU';
      return;
    } else if (text.toLowerCase().includes('incompleto') || text.toLowerCase().includes('faltou') || text.toLowerCase().includes('errado')) {
      const reply = `O item pode ter faltado no estoque.  \nQuando isso acontece, o valor fica automaticamente como haver para o detento usar em outro pedido.\n\nTambém pode ter ocorrido substituição por produto similar, conforme nossos itens em estoque.\n\nSeu problema foi solucionado?`;
      await sendText(phone, reply);
      s.state = 'AWAITING_CONFIRM_ISSUE';
      s.lastIssue = 'PEDIDO_INCOMPLETO';
      return;
    } else if (text.toLowerCase().includes('modificar')) {
      await sendText(phone, `Para modificar seu pedido, envie o número do pedido e descreva as alterações desejadas.\n\nExemplo:\nPedido 1234\nTrocar 1 Coca por 1 Sukita`);
      s.state = 'AWAITING_MODIFY';
      return;
    } else if (text.toLowerCase().includes('cancelar')) {
      await sendText(phone, `Para cancelar seu pedido, envie o número do pedido.\n\nExemplo:\nPedido 1234`);
      s.state = 'AWAITING_CANCEL';
      return;
    } else if (text.toLowerCase().includes('outro') || text.toLowerCase().includes('atendente')) {
      await sendText(phone, `Certo! Estou encaminhando sua conversa para um atendente. Aguarde um instante, por favor.`);
      await sendText(ADMIN_WHATSAPP, `Cliente ${phone} pediu atendimento humano (OUTRO). Unidade: ${s.unit}`);
      s.state = 'AWAITING_HUMAN';
      return;
    } else if (text.toLowerCase().includes('voltar')) {
      await sendUnitMenu(phone, s.unit);
      return;
    } else {
      await fallbackToHuman(phone);
      return;
    }
  }

  // confirm issue yes/no
  if (s.state === 'AWAITING_CONFIRM_ISSUE') {
    if (text.toLowerCase().startsWith('s') || text.toLowerCase().includes('sim') || text === '1') {
      await sendText(phone, 'Obrigada! Tenha um bom dia 😊');
      await sendUnitMenu(phone, s.unit);
      return;
    } else if (text.toLowerCase().startsWith('n') || text.toLowerCase().includes('não') || text.toLowerCase().includes('nao') || text === '2') {
      await sendText(phone, 'Aguarde um instante, estamos transferindo para um atendente.');
      await sendText(ADMIN_WHATSAPP, `Cliente ${phone} solicitou atendimento (issue ${s.lastIssue}). Unidade: ${s.unit}`);
      s.state = 'AWAITING_HUMAN';
      return;
    } else {
      await fallbackToHuman(phone);
      return;
    }
  }

  // modify/cancel states: forward to discord (for now, forward to admin whatsapp)
  if (s.state === 'AWAITING_MODIFY') {
    // expecting "Pedido 1234 - alterar..."
    await sendText(ADMIN_WHATSAPP, `Modificar pedido solicitado por ${phone}: ${text}`);
    await sendText(phone, 'Pedido enviado para alteração! Caso o número informado não exista, retornaremos avisando.');
    s.state = 'AWAITING_HUMAN';
    return;
  }

  if (s.state === 'AWAITING_CANCEL') {
    await sendText(ADMIN_WHATSAPP, `Cancelar pedido solicitado por ${phone}: ${text}`);
    await sendText(phone, 'Pedido enviado para cancelamento! Caso o número informado não exista, retornaremos avisando.');
    s.state = 'AWAITING_HUMAN';
    return;
  }

  // awaiting name+cpf for consultation
  if (s.state === 'AWAITING_NAME_CPF') {
    // try to parse "Nome – CPF"
    const parts = text.split(/[-–—]/).map(p => p.trim()).filter(Boolean);
    let name = '', cpf = '';
    if (parts.length >= 2) {
      name = parts[0];
      cpf = parts[1].replace(/\D/g, '');
    } else {
      // try last token CPF
      const tokens = text.trim().split(/\s+/);
      const maybeCpf = tokens[tokens.length - 1].replace(/\D/g, '');
      if (maybeCpf.length >= 8) {
        cpf = maybeCpf;
        name = tokens.slice(0, tokens.length - 1).join(' ');
      } else {
        // cannot parse
        await sendText(phone, 'Não entendi. Envie no formato: Nome completo – 123.456.789-00');
        return;
      }
    }

    // attempt to fetch workbook from FILE_URLS for this unit
    const unit = s.unit;
    const fileUrl = (FILE_URLS && FILE_URLS[unit]) ? FILE_URLS[unit] : null;
    if (!fileUrl) {
      await sendText(phone, 'Planilha da unidade não configurada. Por favor, informe ao atendente.');
      await sendText(ADMIN_WHATSAPP, `Planilha não configurada para unidade ${unit}. Cliente: ${phone}`);
      s.state = 'AWAITING_HUMAN';
      return;
    }

    try {
      const wb = await fetchWorkbookFromUrl(fileUrl);
      // try find by cpf or name
      const byCpf = findCustomerInWorkbook(wb, cpf);
      const byName = findCustomerInWorkbook(wb, name);
      let found = null;
      if (byCpf) found = byCpf;
      else if (byName) found = byName;

      if (!found) {
        await sendText(phone, 'Não encontramos dados para o nome/CPF informado.');
        await sendUnitMenu(phone, s.unit);
        return;
      }
      const cust = parseCustomerSheet(found.sheet);
      // Try to set name/cpf fields if blank
      if (!cust.name) cust.name = name;
      if (!cust.cpf) cust.cpf = cpf;

      const replyText = buildCustomerReply(unit, cust);
      await sendText(phone, replyText);
      // add button Voltar ao menu principal: just send a short instruction
      await sendText(phone, 'Digite "Voltar" para retornar ao menu principal.');
      s.state = 'AWAITING_OPTION_AFTER_CONSULT';
      return;
    } catch (err) {
      console.error('Erro ao consultar planilha', err);
      await sendText(phone, 'Erro ao consultar a planilha. Encaminhando para atendente.');
      await sendText(ADMIN_WHATSAPP, `Erro ao consultar planilha para unidade ${unit}: ${err.message}`);
      s.state = 'AWAITING_HUMAN';
      return;
    }
  }

  // default fallback: if unknown content, forward to human
  await fallbackToHuman(phone);
}

// ========== webhook endpoint ==========
// Z-API will POST here when a message arrives. The exact payload varies; we support common fields.
// For safety, inspect the incoming body structure in your Z-API console and adapt property names.
app.post('/webhook', async (req, res) => {
  try {
    // Example Z-API payload (adjust if different):
    // { "id":"...","type":"message","body":{ "sender":"5511xxxx", "message":"olá" } }
    const body = req.body;
    // Try to find phone and text robustly
    let phone = '';
    let text = '';
    // common z-api formats:
    if (body && body.type === 'message' && body.from) {
      phone = body.from;
      text = (body.body && body.body.text) ? body.body.text : body.message || '';
    } else if (body && body.message && body.message.chatId) {
      phone = body.message.chatId.replace('@c.us','').replace('@s.whatsapp.net','');
      if (body.message.type === 'chat') text = body.message.body;
      else if (body.message.type === 'buttons_response') text = body.message.selectedButtonId || body.message.selectedButtonText || '';
    } else {
      // fallback: try to inspect common shapes
      if (body && body.sender && body.message) {
        phone = body.sender;
        text = body.message;
      } else {
        // unknown, just ack
        console.log('Webhook body shape unknown', JSON.stringify(body).substring(0,400));
      }
    }

    if (!phone) {
      res.status(200).send('ok');
      return;
    }

    // Normalize phone to BR style without + or spaces
    phone = phone.replace(/\D/g, '');

    // process text
    await handleIncoming(phone, text, body);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook handler error', err);
    res.status(500).send('error');
  }
});

app.get('/', (req, res) => res.send('Cantina bot running'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
