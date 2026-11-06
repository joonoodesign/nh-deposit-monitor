/* ==========================================================================
   주누디자인 NH농협 실시간 입금 확인 및 최근 7일 직원 공유 보드 (app.js)
   - 잔액 / 출금 내역 100% 자동 필터링 (프라이버시 보호)
   - GitHub db-store 브랜치 & Google Apps Script 실시간 양방향 동기화
   - 신규 입금 감지 시 차임벨(Web Audio) + 한국어 음성(TTS) + 데스크톱 알림
   ========================================================================== */

const STORAGE_KEYS = {
  DEPOSITS: 'nh_deposits_data_v1',
  SETTINGS: 'nh_deposits_settings_v1',
  SOUND_ON: 'nh_deposits_sound_on_v1',
  SHOW_TOTAL: 'nh_deposits_show_total_v1',
  DARK_MODE: 'nh_deposits_dark_mode_v1',
  HIDE_TUTORIAL: 'nh_deposits_hide_tutorial_v1'
};

const QUICK_ITEM_TAGS = ['명함', '스티커', '전단지', '빌지/영수증', '리플렛', '카다로그', '시트지'];

let state = {
  deposits: [],
  selectedDayOffset: '7days', // '7days', '0'..'6', 'all'
  statusFilter: 'all',        // 'all', 'unconfirmed', 'confirmed'
  soundEnabled: true,
  showTotalAmount: false,
  isSyncing: false,
  lastSha: null,
  knownIds: new Set(),
  initialLoadDone: false,
  settings: {
    ghOwner: 'joonoodesign',
    ghRepo: 'nh-deposit-monitor',
    ghToken: '',
    gasWebhook: '',
    tgBotToken: '',
    tgChatId: ''
  }
};

// --------------------------------------------------------------------------
// 1. 초기화 및 URL 해시(#ghSync / ?sms) 자동 처리
// --------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  loadLocalSettings();
  handleUrlAutoConnectAndSms();
  loadLocalDeposits();

  renderDayTabs();
  renderDeposits();
  updateKpiSummary();

  // 서비스워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // 최초 접속 튜토리얼 표시 확인
  const hideTut = localStorage.getItem(STORAGE_KEYS.HIDE_TUTORIAL) === 'true';
  const chkTut = document.getElementById('chkHideTutorialStartup');
  if (chkTut) chkTut.checked = hideTut;
  if (!hideTut && !state.settings.ghToken && state.deposits.length === 0) {
    openTutorialModal();
  }

  // 클라우드 최초 동기화 및 6초 주기 실시간 폴링 시작
  await syncFromCloud(true);
  setInterval(() => {
    syncFromCloud(false);
  }, 6000);
});

function loadLocalSettings() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
    state.settings = { ...state.settings, ...savedSettings };
  } catch (e) {}

  const soundPref = localStorage.getItem(STORAGE_KEYS.SOUND_ON);
  state.soundEnabled = soundPref === null ? true : soundPref === 'true';
  updateSoundButtonUI();

  state.showTotalAmount = localStorage.getItem(STORAGE_KEYS.SHOW_TOTAL) === 'true';

  if (localStorage.getItem(STORAGE_KEYS.DARK_MODE) === 'true') {
    document.body.classList.add('dark-mode');
  }
}

function loadLocalDeposits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DEPOSITS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.deposits = parsed;
        parsed.forEach((d) => state.knownIds.add(d.id));
      }
    }
  } catch (e) {
    state.deposits = [];
  }
}

function saveLocalDeposits() {
  localStorage.setItem(STORAGE_KEYS.DEPOSITS, JSON.stringify(state.deposits));
}

function handleUrlAutoConnectAndSms() {
  const hash = window.location.hash || '';
  const search = window.location.search || '';

  // 1) #ghSync=... 원클릭 자동 연결 해시 처리
  if (hash.includes('ghSync=')) {
    try {
      const match = hash.match(/ghSync=([^&]+)/);
      if (match && match[1]) {
        const rawVal = decodeURIComponent(match[1]);
        let decodedObj = null;
        try {
          decodedObj = JSON.parse(atob(rawVal));
        } catch (_) {
          // 단순 토큰 문자열인 경우
          decodedObj = { ghToken: rawVal };
        }
        if (decodedObj) {
          state.settings = {
            ...state.settings,
            ghOwner: decodedObj.o || decodedObj.ghOwner || state.settings.ghOwner || 'joonoodesign',
            ghRepo: decodedObj.r || decodedObj.ghRepo || state.settings.ghRepo || 'nh-deposit-monitor',
            ghToken: decodedObj.t || decodedObj.ghToken || state.settings.ghToken,
            gasWebhook: decodedObj.g || decodedObj.gasWebhook || state.settings.gasWebhook,
            tgBotToken: decodedObj.tb || decodedObj.tgBotToken || state.settings.tgBotToken,
            tgChatId: decodedObj.tc || decodedObj.tgChatId || state.settings.tgChatId
          };
          localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
          showToast('실시간 동기화 연결 완료', '농협 실시간 입금 공유 DB에 자동으로 연결되었습니다.');
        }
      }
    } catch (e) {
      console.error('ghSync parse error:', e);
    }
  }

  // 2) ?sms=... 또는 #sms=... 휴대폰 단축어 직접 호출 처리
  const urlParams = new URLSearchParams(search);
  let smsText = urlParams.get('sms') || '';
  if (!smsText && hash.includes('sms=')) {
    const m = hash.match(/sms=([^&]+)/);
    if (m && m[1]) smsText = decodeURIComponent(m[1]);
  }

  if (smsText) {
    setTimeout(async () => {
      const added = ingestRawText(smsText, true);
      if (added > 0) {
        await pushToCloud();
      }
    }, 400);
  }

  // 주소창에서 민감한 해시/파라미터 깔끔하게 제거
  if (hash.includes('ghSync=') || hash.includes('sms=') || search.includes('sms=')) {
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

// --------------------------------------------------------------------------
// 2. 농협은행 입금 문자(SMS) & 인터넷뱅킹 7일 내역 스마트 파서 (잔액·출금 완벽 차단)
// --------------------------------------------------------------------------
function parseNHDepositText(rawText) {
  if (!rawText || !rawText.trim()) return [];

  // 잔액 표기 패턴 제거 (프라이버시 보호)
  const stripBalance = (str) => {
    return str
      .replace(/잔액\s*[:：]?\s*[\d,]+\s*원?/gi, '')
      .replace(/가능잔액\s*[:：]?\s*[\d,]+\s*원?/gi, '')
      .replace(/\[Web발신\]/gi, '')
      .replace(/3\d{2}-\d{2,4}-\d{4,6}-\d{1,3}/g, '') // 계좌번호 마스킹/제거
      .replace(/\d{3,6}-\*{2,6}-\*{2,6}-\d{1,4}/g, '')
      .replace(/\d{3,6}-\d{2,4}-\*{2,6}/g, '');
  };

  // 여러 줄의 문자 메시지 블록 또는 엑셀 행 분리
  const normalized = rawText.replace(/\r\n/g, '\n').trim();

  // [Web발신] 또는 [NH농협] 기준으로 덩어리 분리 시도 + 줄 단위 분리 병행
  let chunks = [];
  if (/\[Web발신\]|\[NH농협\]|\[농협\]/i.test(normalized)) {
    const splitByHeader = normalized
      .split(/(?=\[Web발신\]|\[NH농협\]|\[농협\])/i)
      .map((s) => s.trim())
      .filter(Boolean);
    // 만약 한 덩어리 안에 줄바꿈으로 여러 단문 문자가 있는 경우 추가 분리
    splitByHeader.forEach((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const depositLineCount = lines.filter((l) => /입금|입금액/.test(l) && /[\d,]+\s*원?/.test(l)).length;
      if (depositLineCount > 1) {
        lines.forEach((l) => chunks.push(l));
      } else {
        chunks.push(block.replace(/\n+/g, ' '));
      }
    });
  } else {
    chunks = normalized.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  const results = [];
  const now = new Date();
  const currentYear = now.getFullYear();

  for (const rawChunk of chunks) {
    // 출금/지급/승인 취소 등은 즉시 제외 (단, '입금'이 명시된 행만 허용)
    if (/출금|지급|체크승인|카드승인|자동이체출금|수수료/.test(rawChunk) && !/입금/.test(rawChunk)) {
      continue;
    }
    if (/출금\s*[\d,]+/.test(rawChunk)) {
      continue;
    }

    // 탭(\t) 또는 공백 다수로 구분된 농협 인터넷뱅킹 엑셀/표 복사 형식 체크
    // 예: 2026-11-06 14:22:10   입금   35,000   0   홍길동   1,250,000
    let cleaned = stripBalance(rawChunk);

    // 금액 추출:
    // 1순위: '입금 35,000원' 또는 '입금35,000' 또는 '35,000원 입금'
    let amount = 0;
    let amountMatch =
      cleaned.match(/입금(?:액)?\s*[:：]?\s*([\d,]{3,})\s*원?/) ||
      cleaned.match(/([\d,]{3,})\s*원\s*입금/) ||
      cleaned.match(/([\d,]{3,})\s*원/);

    if (amountMatch) {
      amount = parseInt(amountMatch[1].replace(/,/g, ''), 10);
    } else {
      // 엑셀 복사 행에서 금액 추출 (날짜/시간 제거 후 첫 번째 유효 금액)
      const withoutDate = cleaned
        .replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ')
        .replace(/\d{1,2}\/\d{1,2}/g, ' ')
        .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
      const numMatch = withoutDate.match(/\b(\d{1,3}(?:,\d{3})+|\d{4,9})\b/);
      if (numMatch) {
        amount = parseInt(numMatch[1].replace(/,/g, ''), 10);
      }
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      continue;
    }

    // 날짜/시간 추출
    let dateStr = '';
    let timeStr = '';

    const fullDateMatch = cleaned.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    const shortDateMatch = cleaned.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?=\s|$)/);
    const timeMatch = cleaned.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);

    if (fullDateMatch) {
      const y = fullDateMatch[1];
      const m = fullDateMatch[2].padStart(2, '0');
      const d = fullDateMatch[3].padStart(2, '0');
      dateStr = `${y}-${m}-${d}`;
    } else if (shortDateMatch) {
      const m = shortDateMatch[1].padStart(2, '0');
      const d = shortDateMatch[2].padStart(2, '0');
      dateStr = `${currentYear}-${m}-${d}`;
    } else {
      const y = currentYear;
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      dateStr = `${y}-${m}-${d}`;
    }

    if (timeMatch) {
      timeStr = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
    } else {
      timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }

    // 입금자명 추출: 은행명, 날짜, 시간, 금액, '입금' 키워드 등을 제거하고 남은 핵심 텍스트
    let sender = cleaned
      .replace(/\[?NH농협\]?|\[?농협은행\]?|\[?농협\]?|NH스마트뱅킹|기업뱅킹/gi, ' ')
      .replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ')
      .replace(/(?:^|\s)\d{1,2}\/\d{1,2}(?=\s|$)/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
      .replace(/입금(?:액)?\s*[:：]?\s*[\d,]+\s*원?/g, ' ')
      .replace(/[\d,]+\s*원/g, ' ')
      .replace(/\b\d{1,3}(?:,\d{3})+\b/g, ' ')
      .replace(/입금|보낸분|성명|기재내용|거래내역|정상/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 탭 구분 엑셀에서 뒤에 남은 숫자(출금 0 등) 정리
    sender = sender.replace(/^0+\s+|\s+0+$/g, '').trim();
    if (!sender) sender = '입금자 미상';

    // 고유 해시 ID 생성 (날짜 + 시간 + 금액 + 입금자명으로 중복 방지)
    const cleanSenderKey = sender.replace(/\s+/g, '');
    const deterministicId = `nh_${dateStr.replace(/-/g, '')}_${timeStr.replace(':', '')}_${amount}_${cleanSenderKey}`;

    const timestampMs = new Date(`${dateStr}T${timeStr}:00`).getTime() || Date.now();

    results.push({
      id: deterministicId,
      date: dateStr,
      time: timeStr,
      timestamp: timestampMs,
      sender: sender,
      amount: amount,
      confirmed: false,
      confirmedAt: null,
      memo: '',
      tags: [],
      updatedAt: Date.now()
    });
  }

  return results;
}

function ingestRawText(rawText, triggerAlert = true) {
  const parsedList = parseNHDepositText(rawText);
  if (parsedList.length === 0) return 0;

  let addedCount = 0;
  let latestNewItem = null;

  for (const item of parsedList) {
    const exists = state.deposits.some((d) => d.id === item.id);
    if (!exists) {
      state.deposits.unshift(item);
      state.knownIds.add(item.id);
      addedCount++;
      if (!latestNewItem) latestNewItem = item;
    }
  }

  if (addedCount > 0) {
    sortDepositsDesc();
    saveLocalDeposits();
    renderDayTabs();
    renderDeposits();
    updateKpiSummary();

    if (triggerAlert && latestNewItem) {
      notifyNewDeposit(latestNewItem, addedCount);
      sendTelegramNotification(latestNewItem, addedCount);
    }
  }

  return addedCount;
}

function sortDepositsDesc() {
  state.deposits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// --------------------------------------------------------------------------
// 3. 실시간 소리(Web Audio 차임벨) & 한국어 음성(TTS) & 팝업 알림 엔진
// --------------------------------------------------------------------------
function playDepositChimeAndTTS(deposit, count = 1) {
  if (!state.soundEnabled) return;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      // 밝고 경쾌한 3음 차임벨 (C5 -> E5 -> G5)
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.14);

        gain.gain.setValueAtTime(0.001, now + idx * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.28, now + idx * 0.14 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.55);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.14);
        osc.stop(now + idx * 0.14 + 0.6);
      });
    }
  } catch (e) {}

  // 한국어 TTS 음성 안내
  if ('speechSynthesis' in window) {
    setTimeout(() => {
      try {
        window.speechSynthesis.cancel();
        const amountText = formatKoreanMoneySpeech(deposit.amount);
        const msgText =
          count > 1
            ? `농협 신규 입금 ${count}건이 도착했습니다. ${deposit.sender}님 ${amountText} 외 ${count - 1}건입니다.`
            : `농협 입금 알림. ${deposit.sender}님, ${amountText} 입금되었습니다.`;
        const utter = new SpeechSynthesisUtterance(msgText);
        utter.lang = 'ko-KR';
        utter.rate = 1.05;
        window.speechSynthesis.speak(utter);
      } catch (e) {}
    }, 550);
  }
}

function formatKoreanMoneySpeech(num) {
  if (num >= 10000) {
    const man = Math.floor(num / 10000);
    const rem = num % 10000;
    return rem > 0 ? `${man}만 ${rem.toLocaleString()}원` : `${man}만원`;
  }
  return `${num.toLocaleString()}원`;
}

function notifyNewDeposit(deposit, count = 1) {
  playDepositChimeAndTTS(deposit, count);

  const title = count > 1 ? `🔔 농협 신규 입금 ${count}건 도착!` : `🔔 농협 신규 입금 도착!`;
  const body = `${deposit.sender} · ${deposit.amount.toLocaleString()}원 (${deposit.time})`;
  showToast(title, body);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: './icon.svg' });
    } catch (e) {}
  }
}

function toggleSoundAlert() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem(STORAGE_KEYS.SOUND_ON, String(state.soundEnabled));
  updateSoundButtonUI();

  if (state.soundEnabled) {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    showToast('소리·음성 알림 켜짐', '새로운 농협 입금이 들어오면 알림음과 음성 안내가 울립니다.');
  } else {
    showToast('소리·음성 알림 꺼짐', '화면에는 실시간으로 표시되며 소리만 무음 처리됩니다.');
  }
}

function updateSoundButtonUI() {
  const btn = document.getElementById('btnSoundToggle');
  if (!btn) return;
  if (state.soundEnabled) {
    btn.classList.add('active-toggle');
    btn.textContent = '🔔 소리·음성 ON';
  } else {
    btn.classList.remove('active-toggle');
    btn.textContent = '🔕 소리 OFF';
  }
}

function showToast(title, desc) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-desc">${escapeHtml(desc)}</div>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

// --------------------------------------------------------------------------
// 4. 최근 7일(일주일) 날짜 필터 및 테이블 렌더링
// --------------------------------------------------------------------------
function getDateStringDaysAgo(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isWithinLast7Days(dateStr) {
  const minDateStr = getDateStringDaysAgo(6); // 오늘 포함 최근 7일 (D-6 ~ 오늘)
  return dateStr >= minDateStr;
}

function renderDayTabs() {
  const container = document.getElementById('dayTabsContainer');
  if (!container) return;

  const weekDays = ['일', '월', '화', '수', '목', '금', '토'];
  const last7Count = state.deposits.filter((d) => isWithinLast7Days(d.date)).length;

  let html = `
    <button class="day-tab ${state.selectedDayOffset === '7days' ? 'active' : ''}" onclick="selectDayTab('7days')">
      🗓️ 최근 7일(일주일) 전체 <span class="tab-count">${last7Count}</span>
    </button>
  `;

  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const dayName = weekDays[d.getDay()];
    const count = state.deposits.filter((item) => item.date === dateStr).length;

    let label = `${mm}/${dd}(${dayName})`;
    if (i === 0) label = `오늘 ${mm}/${dd}(${dayName})`;
    else if (i === 1) label = `어제 ${mm}/${dd}(${dayName})`;

    html += `
      <button class="day-tab ${state.selectedDayOffset === String(i) ? 'active' : ''}" onclick="selectDayTab('${i}')">
        ${label} <span class="tab-count">${count}</span>
      </button>
    `;
  }

  container.innerHTML = html;
}

function selectDayTab(offset) {
  state.selectedDayOffset = offset;
  renderDayTabs();
  renderDeposits();
}

function setStatusFilter(filter) {
  state.statusFilter = filter;
  ['all', 'unconfirmed', 'confirmed'].forEach((k) => {
    const btn = document.getElementById(`statusBtn_${k}`);
    if (btn) btn.classList.toggle('active', k === filter);
  });
  renderDeposits();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  renderDeposits();
}

function getFilteredDeposits() {
  const query = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
  const queryNum = query.replace(/,/g, '');

  return state.deposits.filter((d) => {
    // 날짜 필터
    if (state.selectedDayOffset === '7days') {
      if (!isWithinLast7Days(d.date)) return false;
    } else if (state.selectedDayOffset !== 'all') {
      const targetDate = getDateStringDaysAgo(parseInt(state.selectedDayOffset, 10));
      if (d.date !== targetDate) return false;
    }

    // 확인 상태 필터
    if (state.statusFilter === 'unconfirmed' && d.confirmed) return false;
    if (state.statusFilter === 'confirmed' && !d.confirmed) return false;

    // 검색어 필터 (입금자명, 금액, 메모, 태그)
    if (query) {
      const matchSender = (d.sender || '').toLowerCase().includes(query);
      const matchMemo = (d.memo || '').toLowerCase().includes(query);
      const matchTag = (d.tags || []).some((t) => t.toLowerCase().includes(query));
      const matchAmount = String(d.amount).includes(queryNum) || d.amount.toLocaleString().includes(query);
      if (!matchSender && !matchMemo && !matchTag && !matchAmount) return false;
    }

    return true;
  });
}

function renderDeposits() {
  const tbody = document.getElementById('depositTableBody');
  const emptyBox = document.getElementById('emptyStateBox');
  if (!tbody || !emptyBox) return;

  const list = getFilteredDeposits();

  if (list.length === 0) {
    tbody.innerHTML = '';
    emptyBox.style.display = 'block';
    return;
  }

  emptyBox.style.display = 'none';
  const todayStr = getDateStringDaysAgo(0);
  const yesterdayStr = getDateStringDaysAgo(1);

  tbody.innerHTML = list
    .map((d) => {
      const rowClass = d.confirmed ? 'row-confirmed' : 'row-unconfirmed';
      let dayBadge = d.date.slice(5).replace('-', '/');
      if (d.date === todayStr) dayBadge = '오늘';
      else if (d.date === yesterdayStr) dayBadge = '어제';

      const tagsHtml = QUICK_ITEM_TAGS.map((tag) => {
        const selected = Array.isArray(d.tags) && d.tags.includes(tag);
        return `<span class="tag-chip ${selected ? 'selected' : ''}" onclick="toggleDepositTag('${d.id}', '${tag}')">${tag}</span>`;
      }).join('');

      return `
        <tr class="deposit-row ${rowClass}">
          <td class="time-cell">
            <div><span style="color:var(--nh-navy); font-weight:800;">${dayBadge}</span> ${escapeHtml(d.time)}</div>
            <span class="time-rel">${escapeHtml(d.date)}</span>
          </td>
          <td class="sender-cell">
            <span class="sender-bank-tag">NH입금</span>${escapeHtml(d.sender)}
          </td>
          <td class="amount-cell">
            +${Number(d.amount).toLocaleString()}원
          </td>
          <td>
            <button
              class="btn-check-status ${d.confirmed ? 'confirmed' : 'unconfirmed'}"
              onclick="toggleConfirmStatus('${d.id}')"
            >
              ${d.confirmed ? '✅ 확인완료' : '🚨 미확인 (체크)'}
            </button>
          </td>
          <td>
            <div class="memo-wrap">
              <div class="quick-tags">${tagsHtml}</div>
              <div class="memo-input-row">
                <input
                  type="text"
                  class="memo-input"
                  placeholder="담당자/메모 입력 후 Enter (예: 김대리 확인)"
                  value="${escapeHtml(d.memo || '')}"
                  onkeydown="if(event.key==='Enter'){this.blur();}"
                  onblur="updateDepositMemo('${d.id}', this.value)"
                />
              </div>
            </div>
          </td>
          <td>
            <div class="action-cell">
              <button class="btn-icon-sm" onclick="shareSingleDepositKakao('${d.id}')" title="카톡/메신저 공유용 복사">💬 카톡복사</button>
              <button class="btn-icon-sm" style="color:var(--text-muted);" onclick="deleteDepositItem('${d.id}')" title="삭제">✕</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function updateKpiSummary() {
  const todayStr = getDateStringDaysAgo(0);
  const last7List = state.deposits.filter((d) => isWithinLast7Days(d.date));
  const todayList = state.deposits.filter((d) => d.date === todayStr);
  const unconfirmedList = last7List.filter((d) => !d.confirmed);

  const elUnconfCount = document.getElementById('kpiUnconfirmedCount');
  const elUnconfSub = document.getElementById('kpiUnconfirmedSub');
  const elTodayCount = document.getElementById('kpiTodayCount');
  const elTodaySub = document.getElementById('kpiTodaySub');
  const elWeekCount = document.getElementById('kpiWeekCount');
  const elWeekSub = document.getElementById('kpiWeekSub');
  const banner = document.getElementById('liveUnconfirmedBanner');
  const bannerText = document.getElementById('liveBannerText');
  const btnToggleTotal = document.getElementById('btnToggleTotal');

  if (elUnconfCount) elUnconfCount.textContent = `${unconfirmedList.length}건`;
  if (elUnconfSub) {
    elUnconfSub.textContent =
      unconfirmedList.length > 0
        ? `최근: ${unconfirmedList[0].sender} (${unconfirmedList[0].amount.toLocaleString()}원)`
        : '모든 입금이 확인 완료되었습니다';
  }

  const todaySum = todayList.reduce((acc, cur) => acc + (cur.amount || 0), 0);
  const weekSum = last7List.reduce((acc, cur) => acc + (cur.amount || 0), 0);

  if (btnToggleTotal) {
    btnToggleTotal.textContent = state.showTotalAmount ? '금액합계 숨김' : '금액합계 보기';
  }

  if (elTodayCount) {
    elTodayCount.textContent = state.showTotalAmount
      ? `${todayList.length}건 (${todaySum.toLocaleString()}원)`
      : `${todayList.length}건`;
  }
  if (elTodaySub) {
    elTodaySub.textContent = `확인완료 ${todayList.filter((d) => d.confirmed).length}건 / 미확인 ${todayList.filter((d) => !d.confirmed).length}건`;
  }

  if (elWeekCount) {
    elWeekCount.textContent = state.showTotalAmount
      ? `${last7List.length}건 (${weekSum.toLocaleString()}원)`
      : `${last7List.length}건`;
  }
  if (elWeekSub) {
    elWeekSub.textContent = `최근 7일(${getDateStringDaysAgo(6).slice(5)} ~ 오늘) 입금 내역`;
  }

  if (banner && bannerText) {
    if (unconfirmedList.length > 0) {
      banner.style.display = 'flex';
      bannerText.textContent = `미확인 농협 입금 ${unconfirmedList.length}건이 있습니다! (최근: ${unconfirmedList[0].sender}님 ${unconfirmedList[0].amount.toLocaleString()}원)`;
    } else {
      banner.style.display = 'none';
    }
  }
}

function toggleShowTotalAmount() {
  state.showTotalAmount = !state.showTotalAmount;
  localStorage.setItem(STORAGE_KEYS.SHOW_TOTAL, String(state.showTotalAmount));
  updateKpiSummary();
}

// --------------------------------------------------------------------------
// 5. 직원 입금 확인 체크 / 품목 태그 / 메모 실시간 업데이트
// --------------------------------------------------------------------------
async function toggleConfirmStatus(id) {
  const item = state.deposits.find((d) => d.id === id);
  if (!item) return;
  item.confirmed = !item.confirmed;
  item.confirmedAt = item.confirmed ? new Date().toISOString() : null;
  item.updatedAt = Date.now();

  saveLocalDeposits();
  renderDeposits();
  updateKpiSummary();
  await pushToCloud();
}

async function confirmAllVisible() {
  const visible = getFilteredDeposits().filter((d) => !d.confirmed);
  if (visible.length === 0) return;

  const nowTs = Date.now();
  visible.forEach((d) => {
    d.confirmed = true;
    d.confirmedAt = new Date().toISOString();
    d.updatedAt = nowTs;
  });

  saveLocalDeposits();
  renderDeposits();
  updateKpiSummary();
  showToast('일괄 확인완료', `${visible.length}건의 입금 내역을 확인완료 처리했습니다.`);
  await pushToCloud();
}

async function toggleDepositTag(id, tag) {
  const item = state.deposits.find((d) => d.id === id);
  if (!item) return;
  if (!Array.isArray(item.tags)) item.tags = [];

  if (item.tags.includes(tag)) {
    item.tags = item.tags.filter((t) => t !== tag);
  } else {
    item.tags.push(tag);
  }
  item.updatedAt = Date.now();

  saveLocalDeposits();
  renderDeposits();
  await pushToCloud();
}

async function updateDepositMemo(id, newMemo) {
  const item = state.deposits.find((d) => d.id === id);
  if (!item) return;
  const trimmed = (newMemo || '').trim();
  if ((item.memo || '') === trimmed) return;

  item.memo = trimmed;
  item.updatedAt = Date.now();

  saveLocalDeposits();
  await pushToCloud();
}

async function deleteDepositItem(id) {
  if (!confirm('이 입금 내역을 목록에서 삭제하시겠습니까?')) return;
  state.deposits = state.deposits.filter((d) => d.id !== id);
  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();
  await pushToCloud();
}

function shareSingleDepositKakao(id) {
  const d = state.deposits.find((x) => x.id === id);
  if (!d) return;
  const tagsStr = d.tags && d.tags.length ? `[${d.tags.join('/')}] ` : '';
  const memoStr = d.memo ? ` (${d.memo})` : '';
  const statusStr = d.confirmed ? '✅확인완료' : '🚨미확인';
  const text = `[NH농협 입금확인] ${d.date.slice(5)} ${d.time} | ${d.sender} | ${d.amount.toLocaleString()}원 | ${statusStr} ${tagsStr}${memoStr}`;

  navigator.clipboard.writeText(text).then(() => {
    showToast('카톡 공유 텍스트 복사됨', text);
  });
}

// --------------------------------------------------------------------------
// 6. GitHub `db-store` 브랜치 & Google Apps Script 실시간 양방향 클라우드 동기화
// --------------------------------------------------------------------------
function updateSyncIndicator(online, message) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncStatusText');
  const lastTxt = document.getElementById('lastSyncedTimeText');

  if (dot) dot.classList.toggle('offline', !online);
  if (txt) txt.textContent = message;
  if (lastTxt && online) {
    const now = new Date();
    lastTxt.textContent = `마지막 동기화: ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  }
}

async function syncFromCloud(isInitial = false) {
  if (state.isSyncing) return;
  const { ghOwner, ghRepo, ghToken, gasWebhook } = state.settings;

  if (!ghToken && !gasWebhook) {
    updateSyncIndicator(false, '로컬 모드 (클라우드 설정 필요)');
    state.initialLoadDone = true;
    return;
  }

  state.isSyncing = true;
  try {
    let remoteDeposits = null;

    // 1) GitHub db-store 브랜치에서 deposits.json 읽기
    if (ghToken && ghOwner && ghRepo) {
      const apiUrl = `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/deposits.json?ref=db-store&t=${Date.now()}`;
      const res = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      });

      if (res.ok) {
        const data = await res.json();
        state.lastSha = data.sha;
        const decoded = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
        const parsed = JSON.parse(decoded);
        if (Array.isArray(parsed.deposits)) {
          remoteDeposits = parsed.deposits;
        }
      } else if (res.status === 404) {
        // 초기 파일 생성 시도
        await pushToCloud();
      }
    }

    // 2) Google Apps Script 웹훅(Google Drive DB)에서 읽기 (보조 또는 단독)
    if (!remoteDeposits && gasWebhook) {
      const res = await fetch(`${gasWebhook}?action=list&t=${Date.now()}`);
      if (res.ok) {
        const parsed = await res.json();
        if (Array.isArray(parsed.deposits)) {
          remoteDeposits = parsed.deposits;
        }
      }
    }

    if (Array.isArray(remoteDeposits)) {
      mergeRemoteDeposits(remoteDeposits, !isInitial && state.initialLoadDone);
      updateSyncIndicator(true, '🟢 실시간 동기화 중');
    }
  } catch (e) {
    updateSyncIndicator(false, '동기화 재시도 중...');
  } finally {
    state.isSyncing = false;
    state.initialLoadDone = true;
  }
}

function mergeRemoteDeposits(remoteList, shouldAlertNew) {
  const map = new Map();
  state.deposits.forEach((d) => map.set(d.id, d));

  let newIncomingItems = [];
  let changed = false;

  for (const r of remoteList) {
    if (!r || !r.id) continue;
    const local = map.get(r.id);
    if (!local) {
      map.set(r.id, r);
      changed = true;
      if (!state.knownIds.has(r.id)) {
        state.knownIds.add(r.id);
        newIncomingItems.push(r);
      }
    } else if ((r.updatedAt || 0) > (local.updatedAt || 0)) {
      map.set(r.id, r);
      changed = true;
    }
  }

  if (changed) {
    state.deposits = Array.from(map.values());
    sortDepositsDesc();
    saveLocalDeposits();
    renderDayTabs();
    renderDeposits();
    updateKpiSummary();
  }

  if (shouldAlertNew && newIncomingItems.length > 0) {
    notifyNewDeposit(newIncomingItems[0], newIncomingItems.length);
  }
}

async function pushToCloud() {
  const { ghOwner, ghRepo, ghToken, gasWebhook } = state.settings;
  if (!ghToken && !gasWebhook) return;

  const payloadObj = {
    updatedAt: new Date().toISOString(),
    deposits: state.deposits
  };

  // 1) GitHub db-store 브랜치에 저장
  if (ghToken && ghOwner && ghRepo) {
    try {
      const apiUrl = `https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/deposits.json`;
      // 최신 SHA 먼저 조회하여 충돌 방지
      const getRes = await fetch(`${apiUrl}?ref=db-store&t=${Date.now()}`, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json'
        }
      });

      let remoteSha = state.lastSha;
      if (getRes.ok) {
        const getJson = await getRes.json();
        remoteSha = getJson.sha;
        // 원격 데이터와 먼저 병합 후 저장
        try {
          const remoteDecoded = JSON.parse(decodeURIComponent(escape(atob(getJson.content.replace(/\n/g, '')))));
          if (Array.isArray(remoteDecoded.deposits)) {
            mergeRemoteDeposits(remoteDecoded.deposits, false);
            payloadObj.deposits = state.deposits;
          }
        } catch (_) {}
      }

      const contentBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(payloadObj, null, 2))));
      const body = {
        message: `Update NH deposits (${new Date().toLocaleTimeString('ko-KR')})`,
        content: contentBase64,
        branch: 'db-store'
      };
      if (remoteSha) body.sha = remoteSha;

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (putRes.ok) {
        const putData = await putRes.json();
        state.lastSha = putData.content?.sha || remoteSha;
        updateSyncIndicator(true, '🟢 실시간 동기화 중');
      }
    } catch (e) {
      console.error('GitHub push error:', e);
    }
  }

  // 2) Google Apps Script (Google Drive)에도 동기화
  if (gasWebhook) {
    try {
      await fetch(gasWebhook, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'syncAll', deposits: state.deposits })
      });
    } catch (e) {}
  }
}

async function syncNowManual() {
  showToast('동기화 실행', '최신 농협 입금 내역을 불러오고 있습니다...');
  await syncFromCloud(false);
}

// --------------------------------------------------------------------------
// 7. 모달 조작 & 일괄 붙여넣기 / 샘플 테스트 / 텔레그램 알림
// --------------------------------------------------------------------------
function openPasteModal() {
  document.getElementById('pasteModal')?.classList.add('open');
  setTimeout(() => document.getElementById('bulkPasteTextarea')?.focus(), 100);
}

function closePasteModal() {
  document.getElementById('pasteModal')?.classList.remove('open');
}

async function processBulkPaste() {
  const textarea = document.getElementById('bulkPasteTextarea');
  const raw = textarea?.value || '';
  if (!raw.trim()) {
    alert('붙여넣을 농협 입금 문자나 거래내역 텍스트를 입력해 주세요.');
    return;
  }

  const count = ingestRawText(raw, true);
  if (count === 0) {
    alert('유효한 농협 입금 내역을 찾지 못했거나 이미 모두 등록된 내역입니다. (출금 내역은 자동으로 제외됩니다)');
    return;
  }

  if (textarea) textarea.value = '';
  closePasteModal();
  showToast('입금 내역 등록 완료', `신규 입금 ${count}건이 등록되어 직원들과 실시간 공유되었습니다.`);
  await pushToCloud();
}

async function addManualDeposit() {
  const senderEl = document.getElementById('manualSender');
  const amountEl = document.getElementById('manualAmount');
  const memoEl = document.getElementById('manualMemo');

  const sender = (senderEl?.value || '').trim();
  const amount = parseInt(amountEl?.value || '0', 10);
  const memo = (memoEl?.value || '').trim();

  if (!sender || !amount || amount <= 0) {
    alert('입금자명과 입금액을 정확히 입력해 주세요.');
    return;
  }

  const now = new Date();
  const dateStr = getDateStringDaysAgo(0);
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const id = `nh_${dateStr.replace(/-/g, '')}_${timeStr.replace(':', '')}_${amount}_${sender.replace(/\s+/g, '')}_${now.getSeconds()}`;

  const newItem = {
    id,
    date: dateStr,
    time: timeStr,
    timestamp: now.getTime(),
    sender,
    amount,
    confirmed: false,
    confirmedAt: null,
    memo,
    tags: [],
    updatedAt: Date.now()
  };

  state.deposits.unshift(newItem);
  state.knownIds.add(id);
  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();

  if (senderEl) senderEl.value = '';
  if (amountEl) amountEl.value = '';
  if (memoEl) memoEl.value = '';
  closePasteModal();

  notifyNewDeposit(newItem, 1);
  sendTelegramNotification(newItem, 1);
  await pushToCloud();
}

async function triggerSampleDeposit() {
  const sampleSenders = ['김민수(명함)', '(주)대박푸드', '이서연스티커', '박지훈전단지', '최유진(리플렛)'];
  const sampleAmounts = [35000, 55000, 110000, 9500, 88000];
  const idx = Math.floor(Math.random() * sampleSenders.length);
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  const sampleSms = `[Web발신] NH농협 입금 ${sampleAmounts[idx].toLocaleString()}원 ${mm}/${dd} ${hh}:${min} ${sampleSenders[idx]} 잔액 15,420,000원`;
  const count = ingestRawText(sampleSms, true);
  if (count > 0) {
    await pushToCloud();
  } else {
    // 같은 분에 동일 샘플이 이미 있으면 초 단위 구분 추가
    const altSms = `[Web발신] NH농협 입금 ${(sampleAmounts[idx] + 1000).toLocaleString()}원 ${mm}/${dd} ${hh}:${min} ${sampleSenders[idx]} 잔액 15,420,000원`;
    ingestRawText(altSms, true);
    await pushToCloud();
  }
}

// --------------------------------------------------------------------------
// 8. 설정 모달 & 직원 공유용 원클릭 링크(#ghSync) & Google Apps Script 코드 생성
// --------------------------------------------------------------------------
function openSettingsModal() {
  document.getElementById('ghOwnerInput').value = state.settings.ghOwner || 'joonoodesign';
  document.getElementById('ghRepoInput').value = state.settings.ghRepo || 'nh-deposit-monitor';
  document.getElementById('ghTokenInput').value = state.settings.ghToken || '';
  document.getElementById('gasWebhookInput').value = state.settings.gasWebhook || '';
  document.getElementById('tgBotTokenInput').value = state.settings.tgBotToken || '';
  document.getElementById('tgChatIdInput').value = state.settings.tgChatId || '';

  document.getElementById('settingsModal')?.classList.add('open');
}

function closeSettingsModal() {
  document.getElementById('settingsModal')?.classList.remove('open');
}

async function saveCloudSettings() {
  state.settings.ghOwner = (document.getElementById('ghOwnerInput')?.value || 'joonoodesign').trim();
  state.settings.ghRepo = (document.getElementById('ghRepoInput')?.value || 'nh-deposit-monitor').trim();
  state.settings.ghToken = (document.getElementById('ghTokenInput')?.value || '').trim();
  state.settings.gasWebhook = (document.getElementById('gasWebhookInput')?.value || '').trim();
  state.settings.tgBotToken = (document.getElementById('tgBotTokenInput')?.value || '').trim();
  state.settings.tgChatId = (document.getElementById('tgChatIdInput')?.value || '').trim();

  localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
  closeSettingsModal();
  showToast('설정 저장 완료', '실시간 클라우드 동기화를 즉시 실행합니다.');
  await syncFromCloud(false);
}

function copyStaffShareLink() {
  if (!state.settings.ghToken && !state.settings.gasWebhook) {
    alert('먼저 [⚙️ 연동·알림 설정]에서 GitHub 토큰 또는 Google 웹훅을 연결해 주세요.');
    openSettingsModal();
    return;
  }

  const syncPayload = {
    o: state.settings.ghOwner || 'joonoodesign',
    r: state.settings.ghRepo || 'nh-deposit-monitor',
    t: state.settings.ghToken || '',
    g: state.settings.gasWebhook || '',
    tb: state.settings.tgBotToken || '',
    tc: state.settings.tgChatId || ''
  };

  const encoded = btoa(JSON.stringify(syncPayload));
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const shareUrl = `${baseUrl}#ghSync=${encodeURIComponent(encoded)}`;

  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('🔗 직원 공유링크 복사 완료!', '카카오톡 단톡방에 붙여넣기 하시면 직원들이 클릭 한 번으로 실시간 연결됩니다.');
  });
}

function copyShortcutUrlGuide() {
  const baseUrl = `${window.location.origin}${window.location.pathname}`;
  const guideUrl = `${baseUrl}?sms=`;
  navigator.clipboard.writeText(guideUrl).then(() => {
    showToast('휴대폰 호출 URL 복사됨', `${guideUrl}[단축어 메시지 본문] 형태로 설정하세요.`);
  });
}

function copyGasScriptCode() {
  const ghOwner = state.settings.ghOwner || 'joonoodesign';
  const ghRepo = state.settings.ghRepo || 'nh-deposit-monitor';
  const ghToken = state.settings.ghToken || '여기에_GITHUB_TOKEN_입력';

  const gasCode = `// =========================================================================
// 주누디자인 NH농협 입금 문자(SMS) 24시간 자동 수신 & 구글 드라이브/GitHub 실시간 연동기
// 사용법: script.google.com 에서 새 프로젝트 생성 -> 붙여넣기 -> [배포] -> [새 배포] -> [웹 앱 (모든 사용자)]
// =========================================================================
const GH_OWNER = '${ghOwner}';
const GH_REPO = '${ghRepo}';
const GH_TOKEN = '${ghToken}';

function doGet(e) {
  const sms = (e && e.parameter && e.parameter.sms) ? e.parameter.sms : '';
  if (sms) {
    return handleIncomingSms(sms);
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok', message: 'NH Deposit Webhook Ready' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let sms = '';
  if (e && e.parameter && e.parameter.sms) {
    sms = e.parameter.sms;
  } else if (e && e.postData && e.postData.contents) {
    try {
      const body = JSON.parse(e.postData.contents);
      sms = body.sms || body.message || body.text || e.postData.contents;
    } catch (_) {
      sms = e.postData.contents;
    }
  }
  if (sms) {
    return handleIncomingSms(sms);
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'empty' })).setMimeType(ContentService.MimeType.JSON);
}

function handleIncomingSms(rawText) {
  // 출금 제외 및 잔액 자동 제거
  if (/출금|지급|체크승인/.test(rawText) && !/입금/.test(rawText)) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'ignored_withdrawal' })).setMimeType(ContentService.MimeType.JSON);
  }
  const cleaned = rawText.replace(/잔액\\s*[:：]?\\s*[\\d,]+\\s*원?/gi, '').replace(/\\[Web발신\\]/gi, '');
  const amtMatch = cleaned.match(/([\\d,]{3,})\\s*원/);
  if (!amtMatch) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'no_amount' })).setMimeType(ContentService.MimeType.JSON);
  }
  const amount = parseInt(amtMatch[1].replace(/,/g, ''), 10);
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const dateStr = kst.toISOString().slice(0, 10);
  const timeStr = kst.toISOString().slice(11, 16);

  const sender = cleaned
    .replace(/\\[?NH농협\\]?|\\[?농협\\]?|입금|[\\d,]+\\s*원|\\d{1,2}\\/\\d{1,2}|\\d{1,2}:\\d{2}/gi, ' ')
    .replace(/\\s+/g, ' ')
    .trim() || '입금자';

  const id = 'nh_' + dateStr.replace(/-/g, '') + '_' + timeStr.replace(':', '') + '_' + amount + '_' + sender.replace(/\\s+/g, '');
  const newRecord = {
    id: id,
    date: dateStr,
    time: timeStr,
    timestamp: Date.now(),
    sender: sender,
    amount: amount,
    confirmed: false,
    memo: '',
    tags: [],
    updatedAt: Date.now()
  };

  // GitHub db-store 브랜치에 즉시 추가
  const apiUrl = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/deposits.json';
  const getRes = UrlFetchApp.fetch(apiUrl + '?ref=db-store', {
    headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github.v3+json' },
    muteHttpExceptions: true
  });

  let deposits = [];
  let sha = null;
  if (getRes.getResponseCode() === 200) {
    const data = JSON.parse(getRes.getContentText());
    sha = data.sha;
    const decoded = Utilities.newBlob(Utilities.base64Decode(data.content)).getDataAsString('UTF-8');
    deposits = JSON.parse(decoded).deposits || [];
  }

  if (!deposits.some(d => d.id === id)) {
    deposits.unshift(newRecord);
    const payload = { updatedAt: new Date().toISOString(), deposits: deposits };
    const putBody = {
      message: 'Auto SMS deposit: ' + sender,
      content: Utilities.base64Encode(Utilities.newBlob(JSON.stringify(payload, null, 2)).getBytes()),
      branch: 'db-store'
    };
    if (sha) putBody.sha = sha;

    UrlFetchApp.fetch(apiUrl, {
      method: 'put',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github.v3+json' },
      payload: JSON.stringify(putBody),
      muteHttpExceptions: true
    });
  }

  return ContentService.createTextOutput(JSON.stringify({ status: 'added', record: newRecord })).setMimeType(ContentService.MimeType.JSON);
}`;

  navigator.clipboard.writeText(gasCode).then(() => {
    showToast('Google Apps Script 코드 복사 완료!', 'script.google.com 에 붙여넣고 웹 앱으로 배포하시면 24시간 문자 자동수신이 작동합니다.');
  });
}

// --------------------------------------------------------------------------
// 9. 텔레그램 알림 & 데이터 정리 / 엑셀 내보내기 / 튜토리얼 모달
// --------------------------------------------------------------------------
async function sendTelegramNotification(deposit, count = 1) {
  const { tgBotToken, tgChatId } = state.settings;
  if (!tgBotToken || !tgChatId) return;

  const text =
    count > 1
      ? `🏦 [NH농협 신규 입금 ${count}건]\n• 최근: ${deposit.sender} (${deposit.amount.toLocaleString()}원)\n• 시간: ${deposit.date} ${deposit.time}`
      : `🏦 [NH농협 실시간 입금]\n• 입금자: ${deposit.sender}\n• 입금액: ${deposit.amount.toLocaleString()}원\n• 일시: ${deposit.date} ${deposit.time}`;

  try {
    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text })
    });
  } catch (e) {}
}

async function testTelegramAlert() {
  const token = (document.getElementById('tgBotTokenInput')?.value || '').trim();
  const chatId = (document.getElementById('tgChatIdInput')?.value || '').trim();
  if (!token || !chatId) {
    alert('텔레그램 봇 토큰과 채팅방 ID를 모두 입력해 주세요.');
    return;
  }
  state.settings.tgBotToken = token;
  state.settings.tgChatId = chatId;
  await sendTelegramNotification(
    { sender: '테스트입금(주누디자인)', amount: 50000, date: getDateStringDaysAgo(0), time: '12:00' },
    1
  );
  showToast('텔레그램 테스트 발송', '텔레그램 채팅방을 확인해 주세요.');
}

async function pruneOlderThan7Days() {
  const beforeCount = state.deposits.length;
  state.deposits = state.deposits.filter((d) => isWithinLast7Days(d.date));
  const removed = beforeCount - state.deposits.length;

  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();
  showToast('7일 경과 내역 정리 완료', `${removed}건의 오래된 내역이 정리되었습니다.`);
  await pushToCloud();
}

async function resetAllDataConfirm() {
  if (!confirm('정말로 모든 입금 내역을 초기화하시겠습니까?')) return;
  state.deposits = [];
  state.knownIds.clear();
  saveLocalDeposits();
  renderDayTabs();
  renderDeposits();
  updateKpiSummary();
  closeSettingsModal();
  await pushToCloud();
}

function exportToCSV() {
  const list = getFilteredDeposits();
  if (list.length === 0) {
    alert('내보낼 입금 내역이 없습니다.');
    return;
  }

  const headers = ['입금일자', '입금시간', '입금자명', '입금금액', '확인상태', '품목태그', '담당자메모'];
  const rows = list.map((d) => [
    d.date,
    d.time,
    `"${(d.sender || '').replace(/"/g, '""')}"`,
    d.amount,
    d.confirmed ? '확인완료' : '미확인',
    `"${(d.tags || []).join('/')}"`,
    `"${(d.memo || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `주누디자인_NH농협입금내역_${getDateStringDaysAgo(0)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function openTutorialModal() {
  document.getElementById('tutorialModal')?.classList.add('open');
}

function closeTutorialModal() {
  document.getElementById('tutorialModal')?.classList.remove('open');
}

function toggleTutorialStartup(checked) {
  localStorage.setItem(STORAGE_KEYS.HIDE_TUTORIAL, String(checked));
}

function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem(STORAGE_KEYS.DARK_MODE, String(isDark));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
