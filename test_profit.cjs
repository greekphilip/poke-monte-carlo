const fs = require('fs');

function evalApp(path) {
  const data = fs.readFileSync(path, 'utf8');
  let config = null;
  let cards = [];
  const matchCards = data.match(/const DEFAULT_CARDS = (\[.*?\]);/s);
  if (matchCards) {
    cards = eval(matchCards[1]);
  }
  return { cards };
}

const current = evalApp('app.js');
const backup = evalApp('../monte_carlo_v2 copy/app.js');
const currentTotal = current.cards.reduce((sum, card) => sum + card.raw, 0);
const backupTotal = backup.cards.reduce((sum, card) => sum + card.raw, 0);
console.log('Current raw:', currentTotal);
console.log('Backup raw:', backupTotal);
