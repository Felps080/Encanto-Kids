const crypto = require('crypto');

function response(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(data)
  };
}

function getHeader(headers, name) {
  if (!headers) return '';

  const target = name.toLowerCase();

  const key = Object.keys(headers).find(
    (item) => item.toLowerCase() === target
  );

  return key ? headers[key] : '';
}

function parseSignature(signature) {
  const result = {};

  if (!signature) return result;

  for (const part of signature.split(',')) {
    const [key, value] = part.split('=');

    if (key && value) {
      result[key.trim()] = value.trim();
    }
  }

  return result;
}

function validateWebhookSignature(event, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;

  // Se a chave ainda não estiver configurada,
  // não bloqueia o webhook durante a configuração.
  if (!secret) {
    console.warn(
      'MP_WEBHOOK_SECRET não configurado. Assinatura não validada.'
    );

    return true;
  }

  const xSignature = getHeader(
    event.headers,
    'x-signature'
  );

  const xRequestId = getHeader(
    event.headers,
    'x-request-id'
  );

  if (!xSignature || !xRequestId || !dataId) {
    console.error(
      'Dados necessários para validar o webhook ausentes.'
    );

    return false;
  }

  const parsed = parseSignature(xSignature);

  const ts = parsed.ts;
  const receivedHash = parsed.v1;

  if (!ts || !receivedHash) {
    console.error(
      'Assinatura do Mercado Pago inválida.'
    );

    return false;
  }

  const manifest =
    `id:${String(dataId).toLowerCase()};` +
    `request-id:${xRequestId};` +
    `ts:${ts};`;

  const calculatedHash = crypto
    .createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  const receivedBuffer =
    Buffer.from(receivedHash, 'utf8');

  const calculatedBuffer =
    Buffer.from(calculatedHash, 'utf8');

  if (
    receivedBuffer.length !== calculatedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    calculatedBuffer
  );
}

exports.handler = async (event) => {
  console.log('=== WEBHOOK MERCADO PAGO ===');

  try {
    // ---------------------------------------------------------
    // Aceitar POST
    // ---------------------------------------------------------

    if (event.httpMethod !== 'POST') {
      return response(405, {
        error: 'Método não permitido.'
      });
    }

    // ---------------------------------------------------------
    // Ler body
    // ---------------------------------------------------------

    let body = {};

    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      console.error('Body JSON inválido.');

      return response(400, {
        error: 'JSON inválido.'
      });
    }

    console.log('Notificação recebida:', body);

    // ---------------------------------------------------------
    // Identificar tipo
    // ---------------------------------------------------------

    const notificationType =
      body.type ||
      event.queryStringParameters?.type ||
      '';

    if (notificationType !== 'payment') {
      console.log(
        'Notificação ignorada. Tipo:',
        notificationType
      );

      return response(200, {
        received: true,
        ignored: true
      });
    }

    // ---------------------------------------------------------
    // Pegar ID do pagamento
    // ---------------------------------------------------------

    const paymentId =
      body?.data?.id ||
      event.queryStringParameters?.['data.id'] ||
      event.queryStringParameters?.id;

    if (!paymentId) {
      console.error(
        'ID do pagamento não encontrado.'
      );

      return response(400, {
        error: 'ID do pagamento não informado.'
      });
    }

    // ---------------------------------------------------------
    // Validar assinatura
    // ---------------------------------------------------------

    const validSignature =
      validateWebhookSignature(
        event,
        paymentId
      );

    if (!validSignature) {
      console.error(
        'ASSINATURA DO WEBHOOK INVÁLIDA.'
      );

      return response(401, {
        error: 'Webhook não autorizado.'
      });
    }

    console.log(
      'Webhook autenticado. Payment ID:',
      paymentId
    );

    // ---------------------------------------------------------
    // Access Token
    // ---------------------------------------------------------

    const accessToken =
      process.env.MP_ACCESS_TOKEN;

    if (!accessToken || !accessToken.trim()) {
      console.error(
        'MP_ACCESS_TOKEN não configurado.'
      );

      return response(500, {
        error:
          'Mercado Pago não configurado.'
      });
    }

    // ---------------------------------------------------------
    // Consultar pagamento diretamente no Mercado Pago
    // ---------------------------------------------------------

    const mpResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
      {
        method: 'GET',

        headers: {
          'Authorization':
            `Bearer ${accessToken}`,

          'Content-Type':
            'application/json'
        }
      }
    );

    const responseText =
      await mpResponse.text();

    let payment;

    try {
      payment = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      payment = {};
    }

    if (!mpResponse.ok) {
      console.error(
        'Erro ao consultar pagamento:',
        mpResponse.status,
        payment
      );

      return response(502, {
        error:
          'Não foi possível consultar o pagamento no Mercado Pago.'
      });
    }

    // ---------------------------------------------------------
    // Status real
    // ---------------------------------------------------------

    const mercadoPagoStatus =
      String(payment.status || '')
        .toLowerCase();

    let status;

    switch (mercadoPagoStatus) {

      case 'approved':
        status = 'aprovado';
        break;

      case 'pending':
      case 'in_process':
        status = 'pendente';
        break;

      case 'rejected':
      case 'cancelled':
      case 'refunded':
      case 'charged_back':
        status = 'recusado';
        break;

      default:
        status = 'desconhecido';
    }

    console.log(
      '=== STATUS DO PAGAMENTO ==='
    );

    console.log({
      payment_id: payment.id,
      status: mercadoPagoStatus,
      status_loja: status,
      status_detail: payment.status_detail,
      transaction_amount:
        payment.transaction_amount
    });

    // ---------------------------------------------------------
    // Aqui é onde futuramente podemos registrar o pedido
    // em banco de dados / painel administrativo.
    // ---------------------------------------------------------

    if (status === 'aprovado') {
      console.log(
        'PAGAMENTO APROVADO — PEDIDO PODE SER PROCESSADO.'
      );
    }

    if (status === 'pendente') {
      console.log(
        'PAGAMENTO PENDENTE — AGUARDANDO CONFIRMAÇÃO.'
      );
    }

    if (status === 'recusado') {
      console.log(
        'PAGAMENTO RECUSADO/CANCELADO.'
      );
    }

    // ---------------------------------------------------------
    // Responder ao Mercado Pago
    // ---------------------------------------------------------

    return response(200, {
      received: true,

      payment_id: payment.id,

      status: mercadoPagoStatus,

      status_loja: status,

      status_detail:
        payment.status_detail || null
    });

  } catch (error) {

    console.error(
      'ERRO NO WEBHOOK:',
      error
    );

    return response(500, {
      error:
        'Erro interno ao processar o webhook.'
    });
  }
};
