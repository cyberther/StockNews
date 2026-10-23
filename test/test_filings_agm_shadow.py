import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools/filings-shadow'))
from engine import agm_document
class AgendaTests(unittest.TestCase):
 def doc(self,text):return agm_document({'id':1},[{'page':1,'text':text,'source_id':'p1','origin':'native_geometry'}])
 def test_historical_ordinary_does_not_create_joint_meeting(self):
  d=self.doc('CONVOACA\nADUNAREA GENERALA EXTRAORDINARA A ACTIONARILOR\nin data de 13.10.2026, ora 11:00\nAvand in vedere:\nHotararea Adunarii Generale Ordinare din 23.07.2026\n1. Aprobarea bugetului\n2. Se aproba mandatul\n3. Imputernicirea reprezentantului')
  self.assertEqual(d['selected']['meeting_type']['value'],'AGEA');self.assertEqual(d['selected']['meeting_date']['value'],'2026-10-13');self.assertEqual(d['agendaCount'],3)
 def test_full_sentence_preserves_two_distinct_dates(self):
  d=self.doc('CONVOACA\nADUNAREA GENERALA EXTRAORDINARA A ACTIONARILOR\nin data de 13.10.2026\n1. Aprobarea datei de 30.10.2026 ca data de inregistrare,\nrespectiv 29.10.2026 ca Ex-date.\n2. Se aproba bugetul')
  v=next(f['value'] for f in d['catalog'] if f['field']=='decisions');self.assertIn('30.10.2026',v);self.assertIn('29.10.2026',v);self.assertNotIn('\n',v)
 def test_joint_heading_is_preserved(self):
  d=self.doc('CONVOACA\nADUNAREA GENERALA ORDINARA SI EXTRAORDINARA A ACTIONARILOR\nin data de 13.10.2026\nI. ADUNAREA GENERALA ORDINARA\n1. Aprobarea dividendului\nII. ADUNAREA GENERALA EXTRAORDINARA\n1. Aprobarea capitalului')
  self.assertEqual(d['selected']['meeting_type']['value'],'AGOA+AGEA');self.assertEqual({f['meeting_type'] for f in d['catalog'] if f['field']=='decisions'},{'AGOA','AGEA'})
 def test_conflicting_primary_dates_fail_closed(self):
  d=self.doc('CONVOACA\nADUNAREA GENERALA EXTRAORDINARA A ACTIONARILOR\nin data de 13.10.2026\npentru data de 15.10.2026\n1. Aprobarea bugetului\n2. Se aproba mandatul')
  self.assertNotIn('meeting_date',d['selected']);self.assertEqual(d['status'],'needs_review')
if __name__=='__main__':unittest.main(verbosity=2)
