(function(root){
 'use strict';
 const years=d=>Array.isArray(d.fiscal_years)?d.fiscal_years.filter(y=>Number.isInteger(y)&&y>=1995&&y<=2100):Number.isInteger(d.fiscal_year)?[d.fiscal_year]:[];
 const labels={ro:{turnover:'Cifră de afaceri',total_revenue:'Venituri totale',operating_revenue:'Venituri din exploatare'},en:{turnover:'Turnover',total_revenue:'Total revenue',operating_revenue:'Operating revenue'}};
 root.HifFilings={years,yearLabel:d=>years(d).join(', ')||'—',yearSort:d=>Math.max(0,...years(d)),revenueLabel:(d,loc)=>((labels[String(loc).startsWith('ro')?'ro':'en'])[d.revenue_metric]||''),canCompareRevenue:d=>!d.revenue_metric || d.revenue_metric===d.revenue_prev_metric};
})(globalThis);
