import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// hif-insight.js is a browser script; run it with a window of its own.
const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL('../templates/shared/hif-insight.js', import.meta.url), 'utf8'), ctx);
const { sameEvent } = ctx.window.HIFInsight;
const t0 = 1792000000;
const row = (ticker, headline, snippet, h = 0) => ({ ticker, headline, snippet, ts: t0 - h * 3600 });

test('outlets reporting the same event become one group (real Lufthansa/TAP headlines)', () => {
  const rows = [
    row('LHA.DE', 'TAP: Lufthansa gewinnt Bieterrennen gegen Air France-KLM', 'Erst Ita, jetzt Tap: Die Lufthansa greift nach einem Teil der portugiesischen Fluggesellschaft. Mit ihrem Gebot von 1,2 Milliarden Euro setzte sich die deutsche Airline im Bieterrennen gegen Air France KLM durch.'),
    row('LHA.DE', 'Lufthansa erhält Zuschlag für portugiesische TAP', 'Die Lufthansa kann bei der portugiesischen Fluggesellschaft TAP einsteigen. Die deutsche Airline erhält den Zuschlag für einen Anteil von 44,9 Prozent und hat sich damit gegen den Rivalen Air France-KLM durchgesetzt.', 1),
    row('LHA.DE', 'Luftfahrt: Milliardendeal steht: Lufthansa sticht Air France-KLM im Bieterrennen um TAP aus', 'Die deutsche Airline-Gruppe kann einen Minderheitsanteil an der TAP erwerben. Für das Angebot sprach offenbar, dass die Lufthansa eine Offerte in bar machte.', 2),
    row('LHA.DE', 'Weniger Flüge: Droht Deutschland die Abkopplung vom Luftverkehr?', 'Ryanair zieht sich von zwei deutschen Flughäfen zurück. Auch Lufthansa verkleinert ihr Angebot.', 3),
    row('BAS.DE', 'Chemieindustrie: BASF ist offenbar für höheres Gebot für Evonik bereit', 'Eine Übernahme von Evonik würde BASF im Kerngeschäft stärken. Der Chemiekonzern hält sich ein höheres Angebot offen.', 1),
    row('BAS.DE', 'BASF will Evonik: „Wir geben nicht Milliarden für ein Unternehmen aus“', 'Der Evonik-Vorstand hatte das erste Angebot von BASF für eine Übernahme abgelehnt. Nun könnte der Chemiekonzern sein Gebot erhöhen.', 2),
    row('MBG.DE', 'Locking UK out of Made in Europe law will hurt carmaking, says Mercedes-Benz boss', 'Ola Källenius says it will weaken the industry.', 1),
    row('MBG.DE', 'Mercedes-Benz: Nur dieser radikale Sparkurs kann die Werke retten', 'Mercedes-Chef Ola Källenius eskaliert den Konflikt mit seiner Belegschaft.', 2)
  ];
  const groups = sameEvent(rows, t => ({ 'LHA.DE': 'Lufthansa', 'BAS.DE': 'BASF', 'MBG.DE': 'Mercedes-Benz' })[t]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups)), [[0, 1, 2], [3], [4, 5], [6], [7]]);
});

test('the same words on different tickers, or days apart, stay separate', () => {
  const rows = [
    row('LHA.DE', 'Lufthansa gewinnt Bieterrennen um TAP', 'Portugal privatisiert TAP.'),
    row('AIR.DE', 'Airbus: TAP bestellt im Bieterrennen neue Jets', 'Portugal privatisiert TAP.'),
    row('LHA.DE', 'Lufthansa gewinnt Bieterrennen um TAP', 'Portugal privatisiert TAP.', 72)
  ];
  assert.equal(sameEvent(rows, () => '').length, 3);
});
