import sys,unittest,tempfile,json,hashlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/filings-shadow'))
import worker
class ShadowTests(unittest.TestCase):
 def test_metric_untyped_is_not_verified_by_equal_number(self):
  r=worker.compare({'revenue':100},{'revenue':100},'results',{'revenue':'operating_revenue'})
  self.assertEqual(r['status'],'requires_review');self.assertEqual(r['fields'][0]['status'],'baseline_metric_untyped')
 def test_multi_years_cannot_be_silently_reduced(self):
  r=worker.compare({'fiscal_years':[2023,2024]},{'fiscal_year':2023},'dividend',{})
  self.assertEqual(r['fields'][0]['status'],'difference_requires_review')
 def test_single_year_legacy_comparison(self):
  r=worker.compare({'fiscal_years':[2025]},{'fiscal_year':2025},'dividend',{})
  self.assertEqual(r['status'],'same_comparable_literals')
 def test_agenda_summary_is_not_treated_as_same_source_extract(self):
  r=worker.compare({'meeting_type':'AGOA','decisions':['proposal']},{'meeting_type':'AGOA','decisions':['adopted']},'agm',{})
  self.assertEqual([f['field'] for f in r['fields']],['meeting_type'])
 def test_empty_baseline_is_explicit(self):self.assertEqual(worker.compare({'net_profit':1},None,'results',{})['status'],'no_baseline_data')
 def test_fallback_text_integrity_checked_before_pdf_parsing(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);pdf=root/'a.pdf';pdf.write_bytes(b'%PDF-test');text=root/'a.txt';text.write_text('tampered')
   job=root/'a.json';job.write_text(json.dumps({'sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'textSha256':hashlib.sha256(b'original').hexdigest()}))
   with patch.object(worker,'read_pdf',side_effect=AssertionError('must not parse PDF')):
    with self.assertRaisesRegex(ValueError,'text checksum'):worker.main(job,pdf,text)
if __name__=='__main__':unittest.main(verbosity=2)
