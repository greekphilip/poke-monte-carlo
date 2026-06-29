const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// 1. Remove all batch-related functions and empty them
code = code.replace(/function createPortfolioBatch\(name, cardIds = \[\]\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function saveOptimizerSelectionAsBatch\(\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function batchCardIds\(batchId\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function renderPortfolioBatches\(ranking\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function renderPortfolioStrategy\(ranking\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function markActiveBatchSubmitted\(\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function deleteDraftBatch\(\) \{[\s\S]*?\n\}/g, '');
code = code.replace(/function addSelectedToBatch\(\) \{[\s\S]*?\n\}/g, '');

// 2. Remove renderPortfolioBatches, renderPortfolioStrategy calls in renderPortfolio
code = code.replace(/  renderPortfolioBatches\(ranking\);\n  renderPortfolioStrategy\(ranking\);\n/g, '');

// 3. Remove batch table cell from renderPortfolio mapping
code = code.replace(/      <td><select data-portfolio-field="batchId">[\s\S]*?<\/select><\/td>\n/g, '');

// 4. Remove the portfolioActiveBatchId from state
code = code.replace(/  portfolioActiveBatchId: "",\n/g, '');

// 5. Remove event listeners exactly as they appear
code = code.replace(/  el\("saveOptimizerBatchBtn"\)\.addEventListener\("click", saveOptimizerSelectionAsBatch\);\n/g, '');
code = code.replace(/  el\("createBatchForm"\)\.addEventListener\("submit", \(event\) => \{[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("markBatchSubmittedBtn"\)\.addEventListener\("click", markActiveBatchSubmitted\);\n/g, '');
code = code.replace(/  el\("deleteDraftBatchBtn"\)\.addEventListener\("click", deleteDraftBatch\);\n/g, '');
code = code.replace(/  el\("portfolioBatchFilter"\)\.addEventListener\("change", \(\) => \{[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("addSelectedToBatchBtn"\)\.addEventListener\("click", addSelectedToBatch\);\n/g, '');
code = code.replace(/  el\("portfolioActiveBatch"\)\.addEventListener\("change", \(event\) => \{[\s\S]*?\}\);\n/g, '');

// 6. Fix `modeledCards` to force true
code = code.replace(/function modeledCards\(\) \{\n  const cards = applyPortfolioToCards\(\n    state\.cards,\n    state\.portfolio,\n    liveModeEnabled\(\)\n  \);/g, `function modeledCards() {\n  const cards = applyPortfolioToCards(\n    state.cards,\n    state.portfolio,\n    true\n  );`);

fs.writeFileSync('app.js', code);
