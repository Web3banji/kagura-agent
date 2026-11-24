exports.getRequestPrincipal = async () => globalThis.__testPrincipal;
exports.unauthorizedResponse = (m='Unauthorized') => new Response(JSON.stringify({error:m}), {status:401, headers:{'Content-Type':'application/json'}});
