const DATA_URLS = {
  spi: "nri_spi_questions.json",
  vocabulary: "goi_quiz_110.json"
};
const STORAGE_KEY = "nri-spi-quiz-history";
const QUESTION_STATS_KEY = "nri-spi-quiz-question-stats";
const MISS_REASONS = ["型判定ミス", "図式化ミス", "計算ミス", "条件読み落とし", "時間切れ", "知識不足"];

const state = {
  data: null,
  datasets: {},
  quizType: "language",
  questions: [],
  mode: "focus",
  selectedCategory: "all",
  currentIndex: 0,
  answers: [],
  currentAnswer: null,
  patternAnswer: "",
  patternStartedAt: 0,
  questionStartedAt: 0,
  timeRemaining: 0,
  timerId: null,
  warning: ""
};

const app = document.querySelector("#app");

init();

async function init() {
  try {
    const [spiResponse, vocabularyResponse] = await Promise.all([
      fetch(DATA_URLS.spi),
      fetch(DATA_URLS.vocabulary)
    ]);
    const [spiData, vocabularyData] = await Promise.all([
      spiResponse.json(),
      vocabularyResponse.json()
    ]);
    state.datasets = buildLearningDatasets(spiData, vocabularyData);
    state.data = state.datasets[state.quizType];
    renderHome();
  } catch (error) {
    app.innerHTML = `<div class="panel hero"><h1>問題データを読み込めませんでした</h1><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function normalizeVocabularyData(rawData) {
  return {
    metadata: {
      title: rawData.title || "語彙クイズ"
    },
    categories: [
      {
        id: "vocabulary",
        label: "語彙",
        priority: "A"
      }
    ],
    questions: rawData.questions.map((question) => ({
      id: `G${String(question.id).padStart(3, "0")}`,
      section: "verbal",
      category: "vocabulary",
      weaknessTarget: "語彙の意味",
      difficultyIndicator: 5,
      timeLimitSec: 45,
      answerType: "single",
      prompt: question.question,
      choices: question.choices.map((choice) => ({
        id: choice.label,
        text: choice.text
      })),
      correctAnswer: question.answer,
      patternType: "語彙意味",
      firstMove: question.answer_text || "",
      explanation: question.explanation || ""
    }))
  };
}

function buildLearningDatasets(spiData, vocabularyData) {
  const vocabulary = normalizeVocabularyData(vocabularyData);
  const verbalQuestions = spiData.questions.filter((question) => question.section === "verbal");
  const nonverbalQuestions = spiData.questions.filter((question) => question.section !== "verbal");
  const verbalCategoryIds = new Set(verbalQuestions.map((question) => question.category));
  const nonverbalCategoryIds = new Set(nonverbalQuestions.map((question) => question.category));

  return {
    language: {
      metadata: { title: "言語" },
      categories: [
        ...spiData.categories.filter((category) => verbalCategoryIds.has(category.id)),
        ...vocabulary.categories
      ],
      questions: [...verbalQuestions, ...vocabulary.questions]
    },
    nonverbal: {
      metadata: { title: "非言語" },
      categories: spiData.categories.filter((category) => nonverbalCategoryIds.has(category.id)),
      questions: nonverbalQuestions
    }
  };
}

function renderHome() {
  stopTimer();
  const categories = state.data.categories
    .map((category) => `<option value="${category.id}">${category.label}</option>`)
    .join("");
  const history = loadHistory();
  const last = history[0];
  const achievements = buildAchievementStats();

  app.innerHTML = `
    <div class="home">
      <section class="panel hero">
        <h1>SPI テストセンター想定クイズ</h1>
        <p>1問ずつ解く本番形式で，順番推理・勝敗推理・チェックボックス・濃度問題を重点的に訓練します。</p>
      </section>
      <section class="panel achievement-panel">
        ${renderAchievementGauge("言語", achievements.language)}
        ${renderAchievementGauge("非言語", achievements.nonverbal)}
      </section>
      <section class="panel controls">
        <div class="field">
          <label for="quizType">クイズ</label>
          <select id="quizType">
            <option value="language" ${state.quizType === "language" ? "selected" : ""}>言語</option>
            <option value="nonverbal" ${state.quizType === "nonverbal" ? "selected" : ""}>非言語</option>
          </select>
        </div>
        <div class="field">
          <label for="mode">モード</label>
          <select id="mode">
            <option value="exam">本番モード</option>
            <option value="focus">弱点集中モード</option>
            <option value="pattern">型判定トレーニング</option>
          </select>
        </div>
        <div class="field">
          <label for="category">分野</label>
          <select id="category">
            <option value="all">全分野</option>
            ${categories}
          </select>
        </div>
        <div class="field">
          <label for="count">出題数</label>
          <input id="count" type="number" min="1" max="${state.data.questions.length}" value="10">
        </div>
        <button id="start" class="button">開始</button>
      </section>
      ${last ? renderLastResult(last) : ""}
    </div>
  `;

  document.querySelector("#mode").value = state.mode;
  document.querySelector("#start").addEventListener("click", startQuiz);
  document.querySelector("#quizType").addEventListener("change", (event) => {
    state.quizType = event.target.value;
    state.data = state.datasets[state.quizType];
    state.selectedCategory = "all";
    renderHome();
  });
  document.querySelector("#mode").addEventListener("change", (event) => {
    document.querySelector("#category").disabled = event.target.value === "exam";
  });
}

function renderLastResult(result) {
  return `
    <section class="panel hero">
      <h1>前回結果</h1>
      <div class="stats-grid">
        <div class="stat"><span>正答率</span><strong>${Math.round(result.accuracy * 100)}%</strong></div>
        <div class="stat"><span>正答数</span><strong>${result.correct}/${result.total}</strong></div>
        <div class="stat"><span>平均時間</span><strong>${formatSeconds(result.averageTime)}</strong></div>
        <div class="stat"><span>時間切れ</span><strong>${result.timedOut}</strong></div>
      </div>
    </section>
  `;
}

function buildAchievementStats() {
  const stats = loadQuestionStats();
  return Object.fromEntries(Object.entries(state.datasets).map(([quizType, dataset]) => {
    const total = dataset.questions.length;
    const completed = dataset.questions.filter((question) => {
      return questionStatsIds(question, quizType)
        .some((id) => Number(stats[id]?.correctCount || 0) > 0);
    }).length;
    return [quizType, {
      total,
      completed,
      percent: total ? Math.round((completed / total) * 100) : 0
    }];
  }));
}

function renderAchievementGauge(label, achievement) {
  return `
    <div class="achievement-gauge">
      <div class="gauge-ring" style="--progress:${achievement.percent}%">
        <strong>${achievement.percent}%</strong>
      </div>
      <div>
        <h2>${escapeHtml(label)}</h2>
        <p>${achievement.completed}/${achievement.total} 問達成</p>
      </div>
    </div>
  `;
}

function startQuiz() {
  state.mode = document.querySelector("#mode").value;
  state.selectedCategory = document.querySelector("#category").value;
  const count = Number(document.querySelector("#count").value || 10);
  let pool = [...state.data.questions];

  if (state.mode !== "exam" && state.selectedCategory !== "all") {
    pool = pool.filter((question) => question.category === state.selectedCategory);
  }

  state.questions = selectQuestions(pool, Math.max(1, Math.min(count, pool.length)));
  state.currentIndex = 0;
  state.answers = [];
  beginQuestion();
}

function selectQuestions(pool, count) {
  const stats = loadQuestionStats();
  const weightedPool = pool.map((question) => ({
      question,
      weight: scoreQuestion(question, findQuestionStats(question, stats))
    }));

  return weightedSample(weightedPool, count).map((item) => item.question);
}

function scoreQuestion(question, stats) {
  const now = Date.now();
  let weight = state.mode === "exam" ? weightQuestion(question) : 30;

  if (!stats) {
    weight += 500;
  } else {
    const dueAt = Number(stats.dueAt || 0);
    const lastSeenAt = Number(stats.lastSeenAt || 0);
    const daysSinceSeen = lastSeenAt ? (now - lastSeenAt) / 86400000 : 999;
    const intervalDays = Math.max(1 / 24, Number(stats.intervalDays || 1));
    const elapsedDays = Math.max(0, daysSinceSeen);
    const dueProgress = Math.min(1, elapsedDays / intervalDays);

    if (stats.lastCorrect === false) weight += 420;
    weight += 40 + dueProgress * 260;
    if (dueAt <= now) weight += 180;
    weight += Math.min(daysSinceSeen, 14) * 8;
    weight *= 1 / (1 + Number(stats.correctStreak || 0) * 0.45);
  }

  return Math.max(8, weight);
}

function weightedSample(items, count) {
  const remaining = [...items];
  const selected = [];

  while (remaining.length && selected.length < count) {
    const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
    let pick = Math.random() * totalWeight;
    const index = remaining.findIndex((item) => {
      pick -= item.weight;
      return pick <= 0;
    });
    selected.push(remaining.splice(index >= 0 ? index : remaining.length - 1, 1)[0]);
  }

  return selected;
}

function weightQuestion(question) {
  const weights = {
    order_reasoning: 6,
    win_loss: 6,
    checkbox: 6,
    concentration: 4,
    average: 3,
    reading: 3
  };
  return (weights[question.category] || 2) * 10 + Number(question.difficultyIndicator || 0);
}

function beginQuestion() {
  stopTimer();
  state.currentAnswer = emptyAnswer(currentQuestion());
  state.patternAnswer = "";
  state.warning = "";
  state.patternStartedAt = Date.now();
  state.questionStartedAt = Date.now();
  state.timeRemaining = Number(currentQuestion().timeLimitSec || 90);
  renderQuestion();
  startTimer();
}

function currentQuestion() {
  return state.questions[state.currentIndex];
}

function startTimer() {
  state.timerId = setInterval(() => {
    state.timeRemaining -= 1;
    updateTimer();
    if (state.timeRemaining <= 0) {
      submitAnswer(true);
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

function updateTimer() {
  const timer = document.querySelector("#timer");
  const fill = document.querySelector("#timerFill");
  if (!timer || !fill) return;
  const question = currentQuestion();
  const ratio = Math.max(0, state.timeRemaining / Number(question.timeLimitSec || 90));
  timer.textContent = `残り ${formatSeconds(state.timeRemaining)}`;
  timer.classList.toggle("danger", state.timeRemaining <= 10);
  fill.style.width = `${ratio * 100}%`;
}

function renderQuestion() {
  const question = currentQuestion();
  const category = categoryLabel(question.category);
  const isPatternMode = state.mode === "pattern";
  const showAnswer = !isPatternMode || state.patternAnswer;

  app.innerHTML = `
    <div class="topbar">
      <h1>能力検査 ${modeLabel(state.mode)}</h1>
      <div id="timer" class="timer">残り ${formatSeconds(state.timeRemaining)}</div>
    </div>
    <div class="timer-bar"><div id="timerFill" class="timer-fill"></div></div>
    <main class="quiz-card">
      <div class="meta-grid">
        <div class="meta-item"><span class="meta-label">進捗</span><span class="meta-value">第 ${state.currentIndex + 1} 問 / ${state.questions.length} 問</span></div>
        <div class="meta-item"><span class="meta-label">分野</span><span class="meta-value">${escapeHtml(sectionLabel(question.section))} - ${escapeHtml(category)}</span></div>
        <div class="meta-item"><span class="meta-label">弱点</span><span class="meta-value">${escapeHtml(question.weaknessTarget || "-")}</span></div>
        <div class="meta-item"><span class="meta-label">難易度</span><span class="meta-value">${escapeHtml(String(question.difficultyIndicator || "-"))}</span></div>
      </div>
      <div class="main-grid">
        <section class="question-area">
          ${question.passage ? `<h2 class="section-title">本文</h2><div class="passage">${escapeHtml(question.passage)}</div>` : ""}
          <h2 class="section-title">問題文</h2>
          <p class="prompt">${escapeHtml(question.prompt)}</p>
          <h2 class="section-title">メモ欄</h2>
          <textarea class="scratch" id="scratch" placeholder="条件表，順位，計算式などを自由にメモできます。"></textarea>
        </section>
        <aside class="side-panel">
          ${isPatternMode ? renderPatternSelector(question) : ""}
          ${showAnswer ? renderAnswerInput(question) : ""}
        </aside>
      </div>
      <div class="actions">
        <button id="home" class="button ghost">中断</button>
        <div id="warning" class="warning">${escapeHtml(state.warning)}</div>
        <button id="next" class="button">${state.currentIndex + 1 === state.questions.length ? "採点する" : "回答を確定して次へ"}</button>
      </div>
    </main>
  `;

  updateTimer();
  bindQuestionEvents();
}

function renderPatternSelector(question) {
  const patterns = [...new Set(state.data.questions.map((item) => item.patternType).filter(Boolean))];
  const disabled = state.patternAnswer ? "disabled" : "";
  return `
    <div class="pattern-box">
      <h2 class="section-title">型判定</h2>
      <select id="patternAnswer" ${disabled}>
        <option value="">この問題の型を選択</option>
        ${patterns.map((pattern) => `<option value="${escapeAttr(pattern)}" ${pattern === state.patternAnswer ? "selected" : ""}>${escapeHtml(pattern)}</option>`).join("")}
      </select>
      ${state.patternAnswer ? `<p>選択: <strong>${escapeHtml(state.patternAnswer)}</strong></p>` : ""}
      ${state.patternAnswer ? "" : `<button id="lockPattern" class="button secondary" type="button">型を確定</button>`}
      <p class="section-title">正解型は回答後に結果で確認できます。</p>
    </div>
  `;
}

function renderAnswerInput(question) {
  if (question.answerType === "single") {
    return `
      <h2 class="section-title">選択肢</h2>
      <div class="choices">
        ${question.choices.map((choice) => `
          <label class="choice">
            <input type="radio" name="answer" value="${escapeAttr(choice.id)}">
            <span>${escapeHtml(choice.id)}. ${escapeHtml(choice.text)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  if (question.answerType === "multiple") {
    return `
      <h2 class="section-title">選択肢</h2>
      <p class="section-title">該当するものをすべて選べ</p>
      <div class="choices">
        ${question.choices.map((choice) => `
          <label class="choice">
            <input type="checkbox" name="answer" value="${escapeAttr(choice.id)}">
            <span>${escapeHtml(choice.id)}. ${escapeHtml(choice.text)}</span>
          </label>
        `).join("")}
      </div>
      <p id="selectedCount" class="section-title">選択数: 0</p>
    `;
  }

  if (question.answerType === "numeric") {
    return `
      <h2 class="section-title">回答</h2>
      <input id="answerInput" class="numeric-answer" inputmode="decimal" autocomplete="off" placeholder="半角数字で入力">
    `;
  }

  return `
    <h2 class="section-title">回答</h2>
    <input id="answerInput" class="text-answer" autocomplete="off" placeholder="本文から抜き出して入力">
  `;
}

function bindQuestionEvents() {
  document.querySelector("#home").addEventListener("click", renderHome);
  document.querySelector("#next").addEventListener("click", () => submitAnswer(false));

  const lockPattern = document.querySelector("#lockPattern");
  if (lockPattern) {
    lockPattern.addEventListener("click", () => {
      const value = document.querySelector("#patternAnswer").value;
      if (!value) {
        setWarning("先に型を選択してください。");
        return;
      }
      state.patternAnswer = value;
      state.questionStartedAt = Date.now();
      renderQuestion();
    });
  }

  document.querySelectorAll("input[name='answer']").forEach((input) => {
    input.addEventListener("change", collectAnswer);
  });

  const answerInput = document.querySelector("#answerInput");
  if (answerInput) {
    answerInput.addEventListener("input", collectAnswer);
  }
}

function collectAnswer() {
  const question = currentQuestion();
  if (question.answerType === "single") {
    const checked = document.querySelector("input[name='answer']:checked");
    state.currentAnswer = checked ? checked.value : null;
  } else if (question.answerType === "multiple") {
    state.currentAnswer = [...document.querySelectorAll("input[name='answer']:checked")].map((input) => input.value);
    const count = document.querySelector("#selectedCount");
    if (count) count.textContent = `選択数: ${state.currentAnswer.length}`;
  } else {
    state.currentAnswer = document.querySelector("#answerInput").value.trim();
  }
}

function submitAnswer(timedOut) {
  const question = currentQuestion();
  collectAnswer();

  if (state.mode === "pattern" && !state.patternAnswer && !timedOut) {
    setWarning("先に型を確定してください。");
    return;
  }

  if (!timedOut && !hasAnswer(question, state.currentAnswer)) {
    setWarning("未回答です。回答を入力または選択してください。");
    return;
  }

  const elapsedSec = Math.max(0, Math.round((Date.now() - state.questionStartedAt) / 1000));
  const patternElapsedSec = state.patternAnswer ? Math.max(0, Math.round((state.questionStartedAt - state.patternStartedAt) / 1000)) : null;
  const correct = isCorrect(question, state.currentAnswer);
  const patternCorrect = state.patternAnswer ? state.patternAnswer === question.patternType : null;
  recordQuestionResult(question, correct, elapsedSec, timedOut);

  state.answers.push({
    questionId: question.id,
    answer: normalizeAnswer(state.currentAnswer),
    correct,
    timedOut,
    elapsedSec,
    patternAnswer: state.patternAnswer || null,
    patternCorrect,
    patternElapsedSec,
    scratch: document.querySelector("#scratch")?.value || ""
  });

  if (state.mode === "focus") {
    stopTimer();
    renderFocusFeedback(question, state.answers[state.answers.length - 1]);
    return;
  }

  if (state.currentIndex + 1 >= state.questions.length) {
    finishQuiz();
    return;
  }

  state.currentIndex += 1;
  beginQuestion();
}

function renderConfetti() {
  const colors = ["#16a34a", "#2563eb", "#f59e0b", "#dc2626", "#7c3aed"];
  return `
    <div class="confetti-burst" aria-hidden="true">
      ${Array.from({ length: 28 }, (_, index) => {
        const angle = (index / 28) * Math.PI * 2;
        const distance = 54 + (index % 5) * 18;
        const x = Math.round(Math.cos(angle) * distance);
        const y = Math.round(Math.sin(angle) * 32 - 42 - (index % 4) * 8);
        return `<span style="--i:${index}; --x:${x}px; --y:${y}px; --color:${colors[index % colors.length]}"></span>`;
      }).join("")}
    </div>
  `;
}

function renderFocusFeedback(question, answer) {
  app.innerHTML = `
    <div class="topbar">
      <h1>能力検査 弱点集中モード</h1>
      <div class="timer">回答 ${formatSeconds(answer.elapsedSec)}</div>
    </div>
    <main class="quiz-card">
      <div class="meta-grid">
        <div class="meta-item"><span class="meta-label">進捗</span><span class="meta-value">第 ${state.currentIndex + 1} 問 / ${state.questions.length} 問</span></div>
        <div class="meta-item"><span class="meta-label">分野</span><span class="meta-value">${escapeHtml(categoryLabel(question.category))}</span></div>
        <div class="meta-item"><span class="meta-label">弱点</span><span class="meta-value">${escapeHtml(question.weaknessTarget || "-")}</span></div>
        <div class="meta-item"><span class="meta-label">判定</span><span class="meta-value ${answer.correct ? "correct" : "incorrect"}">${answer.correct ? "正解" : "不正解"}</span></div>
      </div>
      <section class="hero">
        ${answer.correct ? renderConfetti() : ""}
        <p class="prompt">${escapeHtml(question.prompt)}</p>
        <p><strong>自分の回答:</strong> ${escapeHtml(formatAnswer(answer.answer))}</p>
        <p><strong>正答:</strong> ${escapeHtml(formatAnswer(question.correctAnswer))}</p>
        <p><strong>この問題の初手:</strong> ${escapeHtml(question.firstMove || "-")}</p>
        <p><strong>解説:</strong> ${escapeHtml(question.explanation || "-")}</p>
        ${answer.correct ? "" : `
          <div class="field">
            <label>ミス原因</label>
            <select>
              <option value="">選択してください</option>
              ${MISS_REASONS.map((reason) => `<option>${escapeHtml(reason)}</option>`).join("")}
            </select>
          </div>
        `}
      </section>
      <div class="actions">
        <button id="home" class="button ghost">中断</button>
        <div></div>
        <button id="continue" class="button">${state.currentIndex + 1 === state.questions.length ? "結果を見る" : "次へ"}</button>
      </div>
    </main>
  `;

  document.querySelector("#home").addEventListener("click", renderHome);
  document.querySelector("#continue").addEventListener("click", () => {
    if (state.currentIndex + 1 >= state.questions.length) {
      finishQuiz();
      return;
    }
    state.currentIndex += 1;
    beginQuestion();
  });
}

function setWarning(message) {
  state.warning = message;
  const warning = document.querySelector("#warning");
  if (warning) warning.textContent = message;
}

function finishQuiz() {
  stopTimer();
  const result = buildResult();
  saveHistory(result);
  renderResult(result);
}

function buildResult() {
  const total = state.answers.length;
  const correct = state.answers.filter((answer) => answer.correct).length;
  const timedOut = state.answers.filter((answer) => answer.timedOut).length;
  const averageTime = total ? state.answers.reduce((sum, answer) => sum + answer.elapsedSec, 0) / total : 0;
  const patternAnswers = state.answers.filter((answer) => answer.patternCorrect !== null);
  const patternAccuracy = patternAnswers.length ? patternAnswers.filter((answer) => answer.patternCorrect).length / patternAnswers.length : null;
  const categoryStats = groupStats("category");
  const weaknessStats = groupStats("weaknessTarget");
  const wrong = state.answers
    .filter((answer) => !answer.correct)
    .map((answer) => ({ ...answer, question: state.questions.find((question) => question.id === answer.questionId) }));

  return {
    date: new Date().toISOString(),
    mode: state.mode,
    total,
    correct,
    accuracy: total ? correct / total : 0,
    timedOut,
    averageTime,
    indicator: estimateIndicator(correct / Math.max(total, 1), timedOut / Math.max(total, 1), categoryStats),
    patternAccuracy,
    categoryStats,
    weaknessStats,
    answers: state.answers,
    wrong
  };
}

function groupStats(key) {
  const groups = {};
  state.answers.forEach((answer) => {
    const question = state.questions.find((item) => item.id === answer.questionId);
    const label = key === "category" ? categoryLabel(question.category) : question.weaknessTarget || "-";
    if (!groups[label]) groups[label] = { total: 0, correct: 0 };
    groups[label].total += 1;
    if (answer.correct) groups[label].correct += 1;
  });
  return groups;
}

function estimateIndicator(accuracy, timeoutRate, categoryStats) {
  const checkbox = categoryStats["チェックボックス"];
  const checkboxRate = checkbox ? checkbox.correct / checkbox.total : 1;
  if (accuracy >= 0.9 && timeoutRate <= 0.1) return 7;
  if (accuracy >= 0.8 && timeoutRate < 0.1 && checkboxRate >= 0.7) return 6;
  if (accuracy >= 0.7) return 5;
  if (accuracy >= 0.6) return 4;
  return 3;
}

function renderResult(result) {
  app.innerHTML = `
    <section class="panel hero">
      <h1>結果</h1>
      <div class="stats-grid">
        <div class="stat"><span>正答率</span><strong>${Math.round(result.accuracy * 100)}%</strong></div>
        <div class="stat"><span>正答数</span><strong>${result.correct}/${result.total}</strong></div>
        <div class="stat"><span>平均時間</span><strong>${formatSeconds(result.averageTime)}</strong></div>
        <div class="stat"><span>推定指標</span><strong>${result.indicator}</strong></div>
      </div>
      ${result.patternAccuracy === null ? "" : `<p>型判定正答率: <strong>${Math.round(result.patternAccuracy * 100)}%</strong></p>`}
      <button id="restart" class="button">トップへ戻る</button>
    </section>
    <section class="panel hero">
      <h1>分野別成績</h1>
      <div class="result-list">${renderStatsRows(result.categoryStats)}</div>
    </section>
    <section class="panel hero">
      <h1>弱点カテゴリ別成績</h1>
      <div class="result-list">${renderStatsRows(result.weaknessStats)}</div>
    </section>
    <section class="panel hero">
      <h1>復習</h1>
      ${result.wrong.length ? `<div class="review-list">${result.wrong.map(renderReviewRow).join("")}</div>` : "<p>間違えた問題はありません。</p>"}
    </section>
  `;

  document.querySelector("#restart").addEventListener("click", renderHome);
}

function renderStatsRows(stats) {
  return Object.entries(stats).map(([label, value]) => {
    const rate = value.total ? Math.round((value.correct / value.total) * 100) : 0;
    return `
      <div class="row">
        <div class="row-head"><span>${escapeHtml(label)}</span><span>${value.correct}/${value.total} (${rate}%)</span></div>
      </div>
    `;
  }).join("");
}

function renderReviewRow(item) {
  const question = item.question;
  return `
    <div class="row">
      <div class="row-head">
        <span>${escapeHtml(question.id)} ${escapeHtml(categoryLabel(question.category))}</span>
        <span class="${item.correct ? "correct" : "incorrect"}">${item.correct ? "正解" : "不正解"}</span>
      </div>
      ${question.passage ? `<div class="review-passage">${escapeHtml(question.passage)}</div>` : ""}
      <p class="review-prompt"><strong>問題:</strong> ${escapeHtml(question.prompt)}</p>
      ${renderReviewChoices(question)}
      <p><strong>自分の回答:</strong> ${escapeHtml(formatAnswer(item.answer))}</p>
      <p><strong>正答:</strong> ${escapeHtml(formatAnswer(question.correctAnswer))}</p>
      ${item.patternAnswer ? `<p><strong>型判定:</strong> ${escapeHtml(item.patternAnswer)} / 正解型: ${escapeHtml(question.patternType || "-")}</p>` : ""}
      <p><strong>初手:</strong> ${escapeHtml(question.firstMove || "-")}</p>
      <p><strong>解説:</strong> ${escapeHtml(question.explanation || "-")}</p>
      <div class="field">
        <label>ミス原因</label>
        <select>
          <option value="">選択してください</option>
          ${MISS_REASONS.map((reason) => `<option>${escapeHtml(reason)}</option>`).join("")}
        </select>
      </div>
    </div>
  `;
}

function renderReviewChoices(question) {
  if (!question.choices?.length) return "";
  return `
    <div class="review-choices">
      ${question.choices.map((choice) => {
        const correct = Array.isArray(question.correctAnswer)
          ? question.correctAnswer.includes(choice.id)
          : String(question.correctAnswer) === String(choice.id);
        return `
          <div class="review-choice ${correct ? "is-correct" : ""}">
            <span>${escapeHtml(choice.id)}.</span>
            <span>${escapeHtml(choice.text)}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function isCorrect(question, answer) {
  if (question.answerType === "single") {
    return String(answer || "") === String(question.correctAnswer);
  }

  if (question.answerType === "multiple") {
    const actual = [...(Array.isArray(answer) ? answer : [])].sort();
    const expected = [...question.correctAnswer].sort();
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  }

  if (question.answerType === "numeric") {
    const actual = Number(answer);
    const expected = Number(question.correctAnswer);
    const tolerance = Number(question.tolerance || 0);
    return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  }

  const actual = String(answer || "").trim();
  const acceptable = [question.correctAnswer, ...(question.acceptableAnswers || [])].map((value) => String(value).trim());
  return acceptable.includes(actual);
}

function hasAnswer(question, answer) {
  if (question.answerType === "multiple") return Array.isArray(answer) && answer.length > 0;
  return answer !== null && answer !== undefined && String(answer).trim() !== "";
}

function emptyAnswer(question) {
  if (question.answerType === "multiple") return [];
  return "";
}

function normalizeAnswer(answer) {
  return Array.isArray(answer) ? [...answer] : answer;
}

function formatAnswer(answer) {
  if (Array.isArray(answer)) return answer.join(", ");
  if (answer === null || answer === undefined || answer === "") return "未回答";
  return String(answer);
}

function categoryLabel(categoryId) {
  return state.data.categories.find((category) => category.id === categoryId)?.label || categoryId;
}

function sectionLabel(section) {
  return section === "verbal" ? "言語" : "非言語";
}

function modeLabel(mode) {
  if (mode === "focus") return "弱点集中モード";
  if (mode === "pattern") return "型判定トレーニング";
  return "本番モード";
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(result) {
  const history = loadHistory();
  const compact = {
    date: result.date,
    quizType: state.quizType,
    mode: result.mode,
    total: result.total,
    correct: result.correct,
    accuracy: result.accuracy,
    averageTime: result.averageTime,
    timedOut: result.timedOut
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify([compact, ...history].slice(0, 10)));
}

function loadQuestionStats() {
  try {
    return JSON.parse(localStorage.getItem(QUESTION_STATS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveQuestionStats(stats) {
  localStorage.setItem(QUESTION_STATS_KEY, JSON.stringify(stats));
}

function questionStatsId(question) {
  return `${state.quizType}:${question.id}`;
}

function questionStatsIds(question, quizType = state.quizType) {
  const ids = [`${quizType}:${question.id}`];

  if (question.id.startsWith("G")) {
    ids.push(`vocabulary:${question.id}`);
  } else {
    ids.push(`spi:${question.id}`);
  }

  return [...new Set(ids)];
}

function findQuestionStats(question, stats, quizType = state.quizType) {
  return questionStatsIds(question, quizType)
    .map((id) => stats[id])
    .find(Boolean);
}

function recordQuestionResult(question, correct, elapsedSec, timedOut) {
  const stats = loadQuestionStats();
  const id = questionStatsId(question);
  const previous = stats[id] || {};
  const attempts = Number(previous.attempts || 0) + 1;
  const correctCount = Number(previous.correctCount || 0) + (correct ? 1 : 0);
  const correctStreak = correct ? Number(previous.correctStreak || 0) + 1 : 0;
  const wrongStreak = correct ? 0 : Number(previous.wrongStreak || 0) + 1;
  const intervalDays = nextReviewIntervalDays(correct, correctStreak, wrongStreak);
  const now = Date.now();

  stats[id] = {
    attempts,
    correctCount,
    correctStreak,
    wrongStreak,
    lastCorrect: correct && !timedOut,
    lastSeenAt: now,
    dueAt: now + intervalDays * 86400000,
    intervalDays,
    averageTime: previous.averageTime
      ? Math.round((Number(previous.averageTime) * (attempts - 1) + elapsedSec) / attempts)
      : elapsedSec
  };

  saveQuestionStats(stats);
}

function nextReviewIntervalDays(correct, correctStreak, wrongStreak) {
  if (!correct) return wrongStreak >= 2 ? 0 : 1 / 24;
  const intervals = [1, 3, 7, 14, 30, 60];
  return intervals[Math.min(correctStreak - 1, intervals.length - 1)];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
