exports.handler = async (event) => {
  console.log('Webhook Mercado Pago:', event.body || event.queryStringParameters || {});
  return { statusCode: 200, body: 'OK' };
};
