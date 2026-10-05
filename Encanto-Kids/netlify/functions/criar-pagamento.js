const fs = require('node:fs');
const path = require('node:path');

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

function response(statusCode, data) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(data)
  };
}

function getCatalog() {
  // O netlify.toml inclui public/products.json no bundle da Function.
  const possiblePaths = [
    path.join(process.cwd(), 'public', 'products.json'),
    path.join(__dirname, '../../public/products.json'),
    path.join(__dirname, '../public/products.json')
  ];

  for (const file of possiblePaths) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
   } catch (error) {
  console.error('ERRO INTERNO:', error);

  return response(500, {
    error: 'Erro interno ao criar o pagamento.',
    detalhes: String(error?.message || error),
    tipo: error?.name || 'UnknownError'
  });
}
  }

  throw new Error('Arquivo public/products.json não foi encontrado.');
}

exports.handler = async (event) => {
  console.log('=== CRIAR PAGAMENTO ===');
  console.log('Método:', event.httpMethod);

  // Apenas POST
  if (event.httpMethod !== 'POST') {
    return response(405, {
      error: 'Método não permitido.'
    });
  }

  // Verifica o Access Token
  const accessToken = process.env.MP_ACCESS_TOKEN;

  if (!accessToken || !accessToken.trim()) {
    console.error('MP_ACCESS_TOKEN não configurado.');
    
    return response(500, {
      error: 'Mercado Pago não configurado na Netlify. Adicione MP_ACCESS_TOKEN nas variáveis de ambiente.'
    });
  }

  try {
    // ---------------------------------------------------------
    // 1. LER O BODY
    // ---------------------------------------------------------

    let rawBody = event.body || '{}';

    if (event.isBase64Encoded) {
      rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
    }

    let body;

    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      console.error('Erro ao interpretar JSON:', error);

      return response(400, {
        error: 'O pedido enviado pelo site não está em formato JSON válido.'
      });
    }

    console.log('Body recebido:', body);

    // ---------------------------------------------------------
    // 2. VALIDAR PRODUTO
    // ---------------------------------------------------------

    const productId = String(body.product_id || '').trim();

    const requestedQuantity = Number(body.quantity || 1);

    const quantity = Number.isFinite(requestedQuantity)
      ? Math.max(1, Math.min(10, Math.floor(requestedQuantity)))
      : 1;

    if (!productId) {
      return response(400, {
        error: 'Produto não informado.'
      });
    }

    // ---------------------------------------------------------
    // 3. CARREGAR CATÁLOGO
    // ---------------------------------------------------------

    const catalog = getCatalog();

    if (!catalog || !Array.isArray(catalog.products)) {
      console.error('Catálogo inválido:', catalog);

      return response(500, {
        error: 'O catálogo de produtos está inválido.'
      });
    }

    const product = catalog.products.find(
      (item) =>
        item.id === productId &&
        item.active === true &&
        Number.isFinite(Number(item.price_cents))
    );

    if (!product) {
      console.error('Produto não encontrado ou indisponível:', productId);

      return response(400, {
        error: 'Produto inválido ou indisponível.'
      });
    }

    const unitPrice = Number(product.price_cents) / 100;

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      console.error('Preço inválido:', product);

      return response(400, {
        error: 'O preço do produto é inválido.'
      });
    }

    // ---------------------------------------------------------
    // 4. MONTAR URL DO SITE
    // ---------------------------------------------------------

    const host = event.headers?.host;

    if (!host) {
      console.error('Host não encontrado:', event.headers);

      return response(500, {
        error: 'Não foi possível identificar o endereço da loja.'
      });
    }

    const protocol =
      event.headers?.['x-forwarded-proto'] ||
      event.headers?.['X-Forwarded-Proto'] ||
      'https';

    const baseUrl = `${protocol}://${host}`;

    // ---------------------------------------------------------
    // 5. CRIAR PREFERÊNCIA DO MERCADO PAGO
    // ---------------------------------------------------------

    const preference = {
      items: [
        {
          id: String(product.id),
          title: String(product.name),
          quantity,
          currency_id: 'BRL',
          unit_price: unitPrice
        }
      ],

      external_reference: `encanto-${product.id}-${Date.now()}`,

      back_urls: {
        success: `${baseUrl}/?pagamento=sucesso`,
        failure: `${baseUrl}/?pagamento=falhou`,
        pending: `${baseUrl}/?pagamento=pendente`
      },

      auto_return: 'approved',

      notification_url: `${baseUrl}/api/webhook`
    };

    // Frete grátis
    if (catalog.shipping?.free === true) {
      preference.shipments = {
        cost: 0
      };
    }

    console.log('Enviando preferência ao Mercado Pago:', {
      product_id: product.id,
      quantity,
      unit_price: unitPrice
    });

    // ---------------------------------------------------------
    // 6. CHAMAR API DO MERCADO PAGO
    // ---------------------------------------------------------

    const mpResponse = await fetch(
      'https://api.mercadopago.com/checkout/preferences',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },

        body: JSON.stringify(preference)
      }
    );

    // Tenta interpretar a resposta
    let mpData;

    const responseText = await mpResponse.text();

    try {
      mpData = responseText ? JSON.parse(responseText) : {};
    } catch {
      mpData = {
        raw_response: responseText
      };
    }

    console.log('Mercado Pago status:', mpResponse.status);

    // ---------------------------------------------------------
    // 7. TRATAR ERRO DO MERCADO PAGO
    // ---------------------------------------------------------

    if (!mpResponse.ok) {
      console.error(
        'ERRO DO MERCADO PAGO:',
        mpResponse.status,
        mpData
      );

      return response(502, {
        error: 'O Mercado Pago recusou a criação do checkout.',
        mercado_pago_status: mpResponse.status,
        detalhes:
          mpData?.message ||
          mpData?.error ||
          mpData?.cause ||
          'O Mercado Pago não informou detalhes.'
      });
    }

    // ---------------------------------------------------------
    // 8. VALIDAR RETORNO
    // ---------------------------------------------------------

    if (!mpData.init_point) {
      console.error(
        'Mercado Pago não retornou init_point:',
        mpData
      );

      return response(502, {
        error: 'O Mercado Pago criou a preferência, mas não retornou o link de pagamento.'
      });
    }

    console.log('Checkout criado com sucesso.');

    // ---------------------------------------------------------
    // 9. DEVOLVER LINK PARA O SITE
    // ---------------------------------------------------------

    return response(200, {
      init_point: mpData.init_point,
      preference_id: mpData.id
    });

  } catch (error) {
    // ---------------------------------------------------------
    // ERRO INESPERADO
    // ---------------------------------------------------------

    console.error('ERRO INTERNO CRIAR PAGAMENTO:', error);

    return response(500, {
      error: 'Erro interno ao criar o pagamento.',
      detalhes: error?.message || 'Erro desconhecido.'
    });
  }
};
