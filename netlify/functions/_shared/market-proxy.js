// Compatibility entry point for the local servers (scripts/server.mjs) and older imports.
// The market data logic lives in ./market/gateway.js.
export { handleMarketRequest, gatewayStatus, resetGatewayForTests as resetProxyStateForTests } from './market/gateway.js';
