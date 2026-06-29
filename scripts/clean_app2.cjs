const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// Strip out any remaining references
code = code.replace(/function batchCardIds[\s\S]*?(?=function renderPortfolioBatches)/, '');
code = code.replace(/function renderPortfolioBatches[\s\S]*?(?=function renderPortfolioStrategy)/, '');
code = code.replace(/function renderPortfolioStrategy[\s\S]*?(?=function portfolioTableData)/, `function renderPortfolioStrategy() {}
`);
code = code.replace(/function createPortfolioBatch[\s\S]*?(?=function markBatchSubmitted)/, '');
code = code.replace(/function markBatchSubmitted[\s\S]*?(?=function deleteDraftBatch)/, '');
code = code.replace(/function deleteDraftBatch[\s\S]*?(?=function updatePortfolioSelectionControls)/, '');
code = code.replace(/function addSelectedToBatch[\s\S]*?(?=function bindPortfolioEvents)/, '');
code = code.replace(/function savePortfolioRow[\s\S]*?(?=function persistPortfolioChange)/, `function savePortfolioRow(tr) {
  const cardId = tr.dataset.portfolioCardId;
  const value = (field) => {
    const el = tr.querySelector(\`[data-portfolio-field="\${field}"]\`);
    return el && el.value ? el.value : null;
  };
  let record = state.portfolio.records[cardId];
  if (!record) {
    record = { status: "inventory" };
    state.portfolio.records[cardId] = record;
  }
  const prevStatus = record.status;
  Object.assign(record, {
    status: value("status") || "inventory",
    estimatedGrade: value("estimatedGrade") ? Number(value("estimatedGrade")) : null,
    estimateConfidence: value("estimateConfidence") ? Number(value("estimateConfidence")) : null,
    actualGrade: value("actualGrade") ? Number(value("actualGrade")) : null,
    actualSalePrice: value("actualSalePrice") ? Number(value("actualSalePrice")) : null,
  });
  persistPortfolioChange(\`Saved updates for card \${cardId}.\`);
}
`);
code = code.replace(/  el\("portfolioActiveBatch"\)[\s\S]*?(?=\}\);\n)/, '');
code = code.replace(/  el\("addSelectedToBatchBtn"\)[\s\S]*?(?=\}\);\n)/, '');
code = code.replace(/  el\("portfolioActiveBatch"\)\.addEventListener\("change", \(event\) => \{[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("addSelectedToBatchBtn"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\}\);\n/g, '');

fs.writeFileSync('app.js', code);
