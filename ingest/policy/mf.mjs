// The Finance Ministry's press releases (mfinante.gov.ro, RSS "MF-RSS-Comunicate de presa").
// A press release is a statement, whatever it announces: a law it mentions is shown with the
// law's own status only when the Parliament source reports it.
import { parseRss } from '../../netlify/functions/_shared/market/ro-news.js';
import { bucharestDay, clip } from './common.mjs';

export const MF_RSS = 'https://mfinante.gov.ro/ro/despre-minister?p_p_id=com_liferay_asset_publisher_web_portlet_AssetPublisherPortlet_INSTANCE_uwgr&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_resource_id=getRSS&p_p_cacheability=cacheLevelPage';

export function parseMfRss(xml) {
  return parseRss(xml, 'Ministerul Finanțelor').map(x => {
    const num = /\/content\/id\/(\d+)/.exec(x.url);
    return {
      id: 'mf:' + (num ? num[1] : x.url.replace(/^https:\/\/mfinante\.gov\.ro\//, '').slice(0, 120)),
      title: clip(x.headline, 500),
      summary: x.summary ? clip(x.summary, 600) : null,
      event_date: bucharestDay(x.datetime * 1000),
      institution: 'Ministerul Finanțelor',
      initiator: 'Ministerul Finanțelor',
      doc_number: null,
      source_url: x.url,
      status: 'statement',
      stage: 'comunicat de presă',
      certainty: 'official_statement'
    };
  });
}
