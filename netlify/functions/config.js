// Netlify Function: the public config the apps need for Supabase sign-in, mirroring
// GET /api/config on the Node server. See _shared/public-config.js for the variables.
import { publicConfig } from './_shared/public-config.js';

export default async () => Response.json(publicConfig(process.env), { headers: { 'cache-control': 'public, max-age=300' } });

export const config = { path: '/api/config' };
