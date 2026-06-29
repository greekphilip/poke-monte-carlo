const fs = require('fs');

let code = fs.readFileSync('app.js', 'utf8');

// Remove batchAlignment import
code = code.replace(/\n\s*batchAlignment,/g, '');

// Remove batch active state
code = code.replace(/\n\s*portfolioActiveBatchId: "",/g, '');

// Update modeledCards to pass true to applyPortfolioToCards
code = code.replace(
  /function modeledCards\(\) \{\n  const cards = applyPortfolioToCards\(\n    state\.cards,\n    state\.portfolio,\n    liveModeEnabled\(\)\n  \);/g,
  `function modeledCards() {
  const cards = applyPortfolioToCards(
    state.cards,
    state.portfolio,
    true
  );`
);

// Remove the batch functions: batchCardIds, renderPortfolioBatches, renderPortfolioStrategy
code = code.replace(/function batchCardIds[\s\S]*?(?=function portfolioTableData)/, '');

// In portfolioTableData, remove batchId filtering
code = code.replace(/  const batchId = el\("portfolioBatchFilter"\)\.value;\n/g, '');
code = code.replace(/      \(!batchId \|\| record\.batchId === batchId\) &&\n/g, '');
code = code.replace(/      \(!batchId \|\| record\.batchId === batchId\);\n/g, ';\n');

// In portfolioTableData, fix sorting
code = code.replace(
  /  \}\)\.sort\(\(a, b\) => \{\n    const aTracked = portfolioRecord\(a\.id\) \? 0 : 1;\n    const bTracked = portfolioRecord\(b\.id\) \? 0 : 1;\n    if \(aTracked !== bTracked\) return aTracked - bTracked;\n    const aRank = rankById\.get\(String\(a\.id\)\)\?\.rank \?\? Number\.MAX_SAFE_INTEGER;\n    const bRank = rankById\.get\(String\(b\.id\)\)\?\.rank \?\? Number\.MAX_SAFE_INTEGER;\n    return aRank - bRank \|\| a\.card\.localeCompare\(b\.card\);\n  \}\);/g,
  `  }).sort((a, b) => {
    const aRank = rankById.get(String(a.id))?.rank ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankById.get(String(b.id))?.rank ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.card.localeCompare(b.card);
  });`
);

// In renderPortfolio, remove batch function calls
code = code.replace(/  renderPortfolioBatches\(ranking\);\n  renderPortfolioStrategy\(ranking\);\n/, '');

// In renderPortfolio, remove the batch <td> from the table rows
code = code.replace(/      <td><select data-portfolio-field="batchId">.*?<\/select><\/td>\n/g, '');

// Remove batch related button listeners in syncScenariosFromDom (Wait, they are in bindPortfolioEvents probably)
code = code.replace(/function createPortfolioBatch[\s\S]*?(?=function updatePortfolioSelectionControls)/, '');
code = code.replace(/function updatePortfolioSelectionControls[\s\S]*?(?=function addSelectedToBatch)/, '');
code = code.replace(/function addSelectedToBatch[\s\S]*?(?=function bindPortfolioEvents)/, '');

// Re-write updatePortfolioSelectionControls
code = code.replace(/function bindPortfolioEvents/g, `function updatePortfolioSelectionControls() {
  const count = state.portfolioSelectedIds.size;
  if (el("portfolioSelectedCount")) el("portfolioSelectedCount").textContent = \`\${count.toLocaleString()} selected\`;
  if (el("applyBulkStatusBtn")) el("applyBulkStatusBtn").disabled = count === 0;
}

function bindPortfolioEvents`);

// Remove batch button event listeners inside bindPortfolioEvents
code = code.replace(/  el\("createBatchForm"\)\?\.addEventListener\("submit",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("portfolioActiveBatch"\)\?\.addEventListener\("change",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("markBatchSubmittedBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("deleteDraftBatchBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("portfolioBatchFilter"\)\?\.addEventListener\("change",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("addSelectedToBatchBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');

// Add the new applyBulkStatusBtn event listener
code = code.replace(
  /  el\("clearPortfolioSelectionBtn"\)\?\.addEventListener\("click", \(\) => \{[\s\S]*?\}\);\n/,
  `  el("clearPortfolioSelectionBtn")?.addEventListener("click", () => {
    state.portfolioSelectedIds.clear();
    updatePortfolioSelectionControls();
    renderPortfolio();
  });
  el("applyBulkStatusBtn")?.addEventListener("click", () => {
    const status = el("bulkStatusSelect").value;
    if (!status) return;
    let changed = 0;
    state.portfolioSelectedIds.forEach((id) => {
      let record = state.portfolio.records[id];
      if (!record) {
        record = {
          estimatedGrade: null,
          estimateConfidence: 70,
          actualGrade: null,
          actualSalePrice: null,
          batchId: null,
          status: "inventory",
          notes: ""
        };
        state.portfolio.records[id] = record;
      }
      if (record.status !== status) {
        record.status = status;
        changed++;
      }
    });
    if (changed) {
      persistPortfolioChange(\`Updated \${changed} card\${changed === 1 ? "" : "s"}.\`);
    } else {
      toast("No changes made.");
    }
  });\n`
);

// Remove saveOptimizerBatchBtn listener (if it exists)
code = code.replace(/  el\("saveOptimizerBatchBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');


fs.writeFileSync('app.js', code);
