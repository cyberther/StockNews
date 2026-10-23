import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence, evidenceSchema, publicFigures } from '../tools/filings-evidence.mjs';

test('proposed dividend cannot become approved using a draft decision or future payment', () => {
  const source='Hotărârea propusă: AGOA aprobă dividendul. Directoratul propune spre aprobarea AGOA repartizarea profitului. Data plății: 25 iunie 2026.';
  assert.ok(checkEvidence('dividend',{status:'approved',status_evidence:'AGOA aprobă dividendul.'},source));
  assert.ok(checkEvidence('dividend',{status:'paid',status_evidence:'Data plății: 25 iunie 2026.'},source));
  assert.equal(checkEvidence('dividend',{status:'proposed',status_evidence:'Directoratul propune spre aprobarea AGOA repartizarea profitului.'},source),'');
});
test('adopted resolution and actual payment announcement retain their stages', () => {
  assert.equal(checkEvidence('dividend',{status:'approved',status_evidence:'AGOA a aprobat dividendul brut de 2 lei.'},'AGOA a aprobat dividendul brut de 2 lei.'),'');
  assert.equal(checkEvidence('dividend',{status:'paid',status_evidence:'Comunicat privind plata dividendelor aprobate de AGOA.'},'Comunicat privind plata dividendelor aprobate de AGOA.'),'');
  assert.ok(checkEvidence('dividend',{status:'approved',status_evidence:'Adunarea din 28 aprilie'},'Adunarea din 28 aprilie'));
});
test('financial basis needs an exact, explicit, unambiguous source quote', () => {
  const source='Separate financial statements for 2025. The Company is part of a group.';
  assert.equal(checkEvidence('results',{consolidated:false,consolidated_evidence:'Separate financial statements for 2025.'},source),'');
  assert.ok(checkEvidence('results',{consolidated:true,consolidated_evidence:'The Company is part of a group.'},source));
  assert.ok(checkEvidence('results',{consolidated:false,consolidated_evidence:'Invented separate statements'},source));
  assert.equal(checkEvidence('results',{consolidated:null,consolidated_evidence:null},source),'');
  const both='Consolidated and separate financial statements';
  assert.ok(checkEvidence('results',{consolidated:true,consolidated_evidence:both},both));
  assert.equal(checkEvidence('results',{consolidated:true,consolidated_evidence:'Situații financiare consolidate'},'Situații financiare consolidate'),'');
});
test('evidence remains internal and schemas are not mutated', () => {
  const schema={required:['status'],properties:{status:{type:'string'}}};
  const extended=evidenceSchema('dividend',schema);
  assert.deepEqual(schema.required,['status']);
  assert.ok(extended.required.includes('status_evidence'));
  assert.deepEqual(publicFigures({status:'proposed',status_evidence:'quoted'}),{status:'proposed'});
});

test('negative and non-consolidated statements cannot become positive evidence', () => {
  assert.ok(checkEvidence('dividend',{status:'approved',status_evidence:'The dividend is not yet approved'},'The dividend is not yet approved'));
  const source='Non-consolidated financial statements';
  assert.ok(checkEvidence('results',{consolidated:true,consolidated_evidence:source},source));
  assert.equal(checkEvidence('results',{consolidated:false,consolidated_evidence:source},source),'');
});

test('ellipses and fabricated quotations are rejected; exact quoted headings work', () => {
  const source='Hotărârea propusă: repartizarea profitului';
  assert.equal(checkEvidence('dividend',{status:'proposed',status_evidence:'"Hotărârea propusă"'},source),'');
  assert.ok(checkEvidence('dividend',{status:'proposed',status_evidence:'Hotărârea ... profitului'},source));
});
