const fs = require('fs');

let code = fs.readFileSync('app.js', 'utf8');

// 1. Remove batchAlignment import
code = code.replace(/\s*batchAlignment,\n/g, '\n');

// 2. modeledCards to true
code = code.replace(
  /function modeledCards\(\) \{\n  const cards = applyPortfolioToCards\(\n    state\.cards,\n    state\.portfolio,\n    liveModeEnabled\(\)\n  \);/g,
  `function modeledCards() {
  const cards = applyPortfolioToCards(
    state.cards,
    state.portfolio,
    true
  );`
);

// 3. Remove portfolioTableData batch filter and tracked sorting
code = code.replace(/  const batchId = el\("portfolioBatchFilter"\)\.value;\n/g, '');
code = code.replace(/      \(!batchId \|\| record\.batchId === batchId\) &&\n/g, '');
code = code.replace(/      \(!batchId \|\| record\.batchId === batchId\);\n/g, ';\n');

code = code.replace(
  /  \}\)\.sort\(\(a, b\) => \{\n    const aTracked = portfolioRecord\(a\.id\) \? 0 : 1;\n    const bTracked = portfolioRecord\(b\.id\) \? 0 : 1;\n    if \(aTracked !== bTracked\) return aTracked - bTracked;\n    const aRank = rankById\.get\(String\(a\.id\)\)\?\.rank \?\? Number\.MAX_SAFE_INTEGER;\n    const bRank = rankById\.get\(String\(b\.id\)\)\?\.rank \?\? Number\.MAX_SAFE_INTEGER;\n    return aRank - bRank \|\| a\.card\.localeCompare\(b\.card\);\n  \}\);/g,
  `  }).sort((a, b) => {
    const aRank = rankById.get(String(a.id))?.rank ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankById.get(String(b.id))?.rank ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.card.localeCompare(b.card);
  });`
);

// 4. Remove renderPortfolioBatches, renderPortfolioStrategy calls in renderPortfolio
code = code.replace(/  renderPortfolioBatches\(ranking\);\n  renderPortfolioStrategy\(ranking\);\n/g, '');

// 5. Remove batch table cell from renderPortfolio mapping
code = code.replace(/      <td><select data-portfolio-field="batchId">.*?<\/select><\/td>\n/g, '');

// 6. Rewrite updatePortfolioSelectionControls to remove batches
code = code.replace(
  /function updatePortfolioSelectionControls\(\) \{[\s\S]*?\}\n\nfunction addSelectedToBatch/g,
  `function updatePortfolioSelectionControls() {
  const count = state.portfolioSelectedIds.size;
  if (el("portfolioSelectedCount")) el("portfolioSelectedCount").textContent = \`\${count.toLocaleString()} selected\`;
  if (el("applyBulkStatusBtn")) el("applyBulkStatusBtn").disabled = count === 0;
}

function addSelectedToBatch`
);

// 7. Rewrite savePortfolioRow to remove batch updates and add missing fields
code = code.replace(
  /function savePortfolioRow\(tr\) \{[\s\S]*?persistPortfolioChange\(\`Saved updates for card \$\{cardId\}\.\`\);\n\}/g,
  `function savePortfolioRow(tr) {
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
  Object.assign(record, {
    status: value("status") || "inventory",
    estimatedGrade: value("estimatedGrade") ? Number(value("estimatedGrade")) : null,
    estimateConfidence: value("estimateConfidence") ? Number(value("estimateConfidence")) : null,
    actualGrade: value("actualGrade") ? Number(value("actualGrade")) : null,
    actualSalePrice: value("actualSalePrice") ? Number(value("actualSalePrice")) : null,
  });
  persistPortfolioChange(\`Saved updates for card \${cardId}.\`);
}`
);

// 8. Remove the event listeners for batch buttons
code = code.replace(/  el\("createBatchForm"\)\?\.addEventListener\("submit",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("portfolioActiveBatch"\)\?\.addEventListener\("change",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("markBatchSubmittedBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("deleteDraftBatchBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("portfolioBatchFilter"\)\?\.addEventListener\("change",[\s\S]*?\}\);\n/g, '');
code = code.replace(/  el\("addSelectedToBatchBtn"\)\?\.addEventListener\("click",[\s\S]*?\}\);\n/g, '');

// 9. Replace clearPortfolioSelectionBtn with clear AND applyBulkStatusBtn
code = code.replace(
  /  el\("clearPortfolioSelectionBtn"\)\?\.addEventListener\("click", \(\) => \{[\s\S]*?\}\);\n/g,
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

// 10. Empty functions we no longer need (safer than removing them since we don't need regex matching closing brackets)
code = code.replace(/function batchCardIds\(batchId\) \{[\s\S]*?\n\}/g, `function batchCardIds(batchId) { return []; }`);
code = code.replace(/function renderPortfolioBatches\(ranking\) \{[\s\S]*?\n\}/g, `function renderPortfolioBatches(ranking) {}`);
code = code.replace(/function renderPortfolioStrategy\(ranking\) \{[\s\S]*?\n\}/g, `function renderPortfolioStrategy(ranking) {}`);
code = code.replace(/function createPortfolioBatch\(name, cardIds = \[\]\) \{[\s\S]*?\n\}/g, `function createPortfolioBatch(name, cardIds = []) {}`);
code = code.replace(/function markBatchSubmitted\(\) \{[\s\S]*?\n\}/g, `function markBatchSubmitted() {}`);
code = code.replace(/function deleteDraftBatch\(\) \{[\s\S]*?\n\}/g, `function deleteDraftBatch() {}`);
code = code.replace(/function addSelectedToBatch\(\) \{[\s\S]*?\n\}/g, `function addSelectedToBatch() {}`);

fs.writeFileSync('app.js', code);
