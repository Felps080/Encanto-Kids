const catalog = require('../../public/products.json');

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

exports.handler = async (event) => {
  console.log('=== CRIAR PAGAMENTO ===');
  console.log('Método:', event.httpMethod);

  // Apenas POST
  if (event.httpMethod !== 'POST') {
    return response(405, {
      error: 'Método não permitido.'
    });
  }

  // Access Token do Mercado Pago
  const accessToken = process.env.MP_ACCESS_TOKEN;

  if (!accessToken || !accessToken.trim()) {
    console.error('MP_ACCESS_TOKEN não configurado.');

    return response(500, {
      error: 'Mercado Pago não configurado na Netlify.'
    });
  }

  try {
    // Ler dados enviados pelo site
    let body;

    try {
      body = JSON.parse(event.body || '{}');
    } catch (error) {
      console.error('JSON inválido:', error);

      return response(400, {
        error: 'Dados enviados pelo site são inválidos.'
      });
    }

    console.log('Body recebido:', body);

    const productId = String(body.product_id || '').trim();

    const variantId = body.variant_id
      ? String(body.variant_id).trim()
      : '';

    const quantityNumber = Number(body.quantity || 1);

    const quantity = Number.isFinite(quantityNumber)
      ? Math.max(1, Math.min(10, Math.floor(quantityNumber)))
      : 1;

    if (!productId) {
      return response(400, {
        error: 'Produto não informado.'
      });
    }

    // =========================================================
    // PROCURAR PRODUTO
    // =========================================================

    const product = catalog.products.find(
      (item) =>
        item.id === productId &&
        item.active === true
    );

    if (!product) {
      console.error('Produto não encontrado:', productId);

      return response(400, {
        error: 'Produto inválido ou indisponível.'
      });
    }

    // =========================================================
    // IDENTIFICAR VARIAÇÃO
    // =========================================================

    let selectedVariant = null;
    let unitPriceCents = null;

    // Produto possui variações
    if (Array.isArray(product.variants) && product.variants.length > 0) {

      if (!variantId) {
        return response(400, {
          error: 'É necessário selecionar uma variação do produto.'
        });
      }

      selectedVariant = product.variants.find(
        (variant) =>
          variant.id === variantId &&
          Number.isFinite(Number(variant.price_cents))
      );

      if (!selectedVariant) {
        console.error(
          'Variação não encontrada:',
          productId,
          variantId
        );

        return response(400, {
          error: 'Variação inválida ou indisponível.'
        });
      }

      unitPriceCents = Number(selectedVariant.price_cents);

    } else {

      // Produto sem variações
      if (!Number.isFinite(Number(product.price_cents))) {
        console.error(
          'Produto sem preço válido:',
          productId
        );

        return response(400, {
          error: 'Preço do produto inválido.'
        });
      }

      unitPriceCents = Number(product.price_cents);
    }

    // =========================================================
    // VALIDAR PREÇO
    // =========================================================

    if (!Number.isFinite(unitPriceCents) || unitPriceCents <= 0) {
      return response(400, {
        error: 'Preço do produto inválido.'
      });
    }

    const unitPrice = unitPriceCents / 100;

    // =========================================================
    // IDENTIFICAR ENDEREÇO DA LOJA
    // =========================================================

    const host = event.headers?.host;

    if (!host) {
      return response(500, {
        error: 'Não foi possível identificar o endereço da loja.'
      });
    }

    const protocol =
      event.headers?.['x-forwarded-proto'] ||
      event.headers?.['X-Forwarded-Proto'] ||
      'https';

    const baseUrl = `${protocol}://${host}`;

    // =========================================================
    // NOME FINAL DO PRODUTO
    // =========================================================

    const itemTitle = selectedVariant
      ? `${product.name} — ${selectedVariant.name}`
      : product.name;

    // =========================================================
    // REFERÊNCIA EXTERNA
    // =========================================================

    const externalReferenceParts = [
      'encanto',
      product.id
    ];

    if (selectedVariant) {
      externalReferenceParts.push(selectedVariant.id);
    }

    externalReferenceParts.push(Date.now());

    const externalReference =
      externalReferenceParts.join('-');

    // =========================================================
    // CRIAR PREFERÊNCIA DO MERCADO PAGO
    // =========================================================

    const preference = {
      items: [
        {
          id: selectedVariant
            ? `${product.id}-${selectedVariant.id}`
            : String(product.id),

          title: String(itemTitle),

          quantity,

          currency_id: 'BRL',

          unit_price: unitPrice
        }
      ],

      external_reference: externalReference,

      back_urls: {
        success: `${baseUrl}/?pagamento=sucesso`,
        failure: `${baseUrl}/?pagamento=falhou`,
        pending: `${baseUrl}/?pagamento=pendente`
      },

      auto_return: 'approved',

      notification_url: `${baseUrl}/api/webhook`
    };

    // =========================================================
    // FRETE GRÁTIS
    // =========================================================

    if (catalog.shipping?.free === true) {
      preference.shipments = {
        cost: 0
      };
    }

    console.log(
      'Enviando para Mercado Pago:',
      {
        product: product.id,
        variant: selectedVariant?.id || 'única',
        quantity,
        price_cents: unitPriceCents,
        price: unitPrice
      }
    );

    // =========================================================
    // CHAMADA À API DO MERCADO PAGO
    // =========================================================

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

    const responseText = await mpResponse.text();

    let mpData;

    try {
      mpData = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      mpData = {
        raw_response: responseText
      };
    }

    console.log(
      'Mercado Pago status:',
      mpResponse.status
    );

    // =========================================================
    // ERRO DO MERCADO PAGO
    // =========================================================

    if (!mpResponse.ok) {
      console.error(
        'ERRO MERCADO PAGO:',
        mpResponse.status,
        mpData
      );

      return response(502, {
        error:
          'O Mercado Pago recusou a criação do pagamento.',

        status: mpResponse.status,

        detalhes:
          mpData?.message ||
          mpData?.error ||
          'Verifique o Access Token e os dados da preferência.'
      });
    }

    // =========================================================
    // VERIFICAR LINK DE PAGAMENTO
    // =========================================================

    if (!mpData.init_point) {
      console.error(
        'init_point não retornado:',
        mpData
      );

      return response(502, {
        error:
          'O Mercado Pago não retornou o link de pagamento.'
      });
    }

    console.log(
      'CHECKOUT CRIADO COM SUCESSO'
    );

    // =========================================================
    // RESPOSTA PARA O SITE
    // =========================================================

    return response(200, {
      init_point: mpData.init_point,

      preference_id: mpData.id,

      product_id: product.id,

      variant_id:
        selectedVariant?.id || null,

      price_cents: unitPriceCents,

      quantity
    });

  } catch (error) {

    console.error(
      'ERRO INTERNO CRIAR PAGAMENTO:',
      error
    );

    return response(500, {
      error:
        'Erro interno ao criar o pagamento.',

      detalhes:
        error?.message ||
        String(error)
    });
  }
};
