// Pipe this source into the existing worker. Output is schema/counts only; raw records stay in memory.
// Never read credentials, headers, cookies, browser storage, traces, or screenshots. Do not close the browser.
import { chromium } from '@playwright/test';

const origin = 'https://admin.biz-pt.com';
const focused = process.env.COMPANY_INSPECT_PHASE === 'focused';
const networkOnly = process.env.COMPANY_INSPECT_PHASE === 'network';
const knownPaths = focused || networkOnly ? ['/manage/members'] : ['/manage/members', '/manage/self-withdrawals', '/manage/withdrawal-requests'];
const activeText = '\uc9c4\ud589';
const allText = '\uc804\uccb4';
const withdrawnText = '\ud0c8\ud1f4';
const allowedFields = new Set(('data result results content items list members users trainers records rows total totalCount totalElements totalPages totalPage pageCount pagination pageable pageInfo page pageSize size number numberOfElements count offset limit hasNext hasMore last isLast next nextPage nextCursor cursor previous previousPage first empty success status code message id uid memberId member_id userId user_id trainerId trainer_id managerId coachId employeeId ownerId name phone email gender birthDate birthday registrationDate createdAt updatedAt assignedAt assignmentDate startDate endDate active isActive progress memberStatus membershipStatus membershipActivity trainer manager coach employee owner center centerId product productId course courses lecture lectures request requests requestId requestType requestStatus withdrawalType withdrawalStatus withdrawalRequests selfWithdrawals applicationCategory applicant applicantType applicantId specialVideos question answer questions answers submitted isSubmitted title video videos videoId round week schedule fixedSchedule memo').split(' '));
const allowedPathSegments = new Set('api v1 v2 v3 admin manage members member users user trainers trainer center centers products product courses lectures withdrawals self-withdrawals withdrawal-requests withdrawalRequests selfWithdrawals specialVideos special-videos special videos requests request list search status surveys survey answers answer'.split(' '));
const totalFields = new Set(['total', 'totalCount', 'totalElements', 'totalPages', 'totalPage', 'pageCount']);
const nextFields = new Set(['hasNext', 'hasMore', 'last', 'isLast', 'next', 'nextPage', 'nextCursor']);
const trainerFields = new Set(['trainerId', 'trainer_id', 'coachId', 'managerId', 'employeeId', 'ownerId']);
const memberFields = ['uid', 'memberId', 'member_id', 'userId', 'user_id', 'id'];
const safeField = key => allowedFields.has(key) ? key : '<unrecognized-field>';
const safeUrl = raw => {
  const url = new URL(raw);
  return {
    companyDomain: url.hostname === 'biz-pt.com' || url.hostname.endsWith('.biz-pt.com'),
    pathShape: '/' + url.pathname.split('/').filter(Boolean).map(segment => allowedPathSegments.has(segment) ? segment : '<segment>').join('/'),
    queryFields: [...new Set([...url.searchParams.keys()].map(safeField))],
  };
};
const summaries = [];
const pending = new Set();
const networkMetadata = [];
const seenResponses = new Set();
let currentRoute = 'members';
let visibleIds = new Set();
let surveyResponseBody;

function summarizeBody(body) {
  const fields = new Set();
  const collections = [];
  const totals = [];
  const pagination = [];
  const fieldTypes = [];
  const encodedJson = [];
  const unrecognizedFieldKinds = {};
  let visited = 0;
  function walk(node, path, depth, insideCollection = false) {
    if (++visited > 3000 || depth > 5 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (!insideCollection) {
        const rows = node.filter(value => value && typeof value === 'object' && !Array.isArray(value));
        const stableTrainerFields = [...trainerFields].filter(key => rows.some(row => Object.hasOwn(row, key)));
        const trainerValues = new Set();
        let rowsWithTrainerKey = 0, rowsMatchingVisibleMemberIds = 0;
        for (const row of rows) {
          const key = stableTrainerFields.find(field => ['string', 'number'].includes(typeof row[field]));
          if (key) { rowsWithTrainerKey++; trainerValues.add(String(row[key])); }
          if (memberFields.some(field => Object.hasOwn(row, field) && visibleIds.has(String(row[field])))) rowsMatchingVisibleMemberIds++;
        }
        collections.push({ path, rows: node.length, stableTrainerFields, rowsWithTrainerKey, rowsMissingTrainerKey: rows.length - rowsWithTrainerKey, distinctTrainerKeyCount: trainerValues.size, rowsMatchingVisibleMemberIds });
      }
      for (const item of node.slice(0, 3)) walk(item, `${path}[]`, depth + 1, true);
      return;
    }
    const keys = Object.keys(node);
    const hasCollection = keys.some(key => Array.isArray(node[key]));
    for (const key of keys) {
      const label = safeField(key);
      fields.add(`${path}.${label}`);
      if (label === '<unrecognized-field>') {
        const kind = node[key] === null ? 'null' : Array.isArray(node[key]) ? 'array' : typeof node[key];
        unrecognizedFieldKinds[kind] = (unrecognizedFieldKinds[kind] ?? 0) + 1;
        continue;
      }
      const value = node[key];
      fieldTypes.push({ path: `${path}.${key}`, kind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
      if (!insideCollection && key === 'data' && typeof value === 'string') {
        let parsed;
        try { parsed = JSON.parse(value); } catch { /* No decoding or decryption is attempted. */ }
        encodedJson.push({ path: `${path}.${key}`, jsonParseable: parsed !== undefined });
        if (parsed && typeof parsed === 'object') walk(parsed, `${path}.${key}.<json>`, depth + 1, false);
      }
      // Numeric totals are allowed only on an envelope with a collection or pagination metadata.
      const envelope = !insideCollection && (hasCollection || /(?:pagination|pageable|pageInfo)$/.test(path));
      if (envelope && totalFields.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) totals.push({ path: `${path}.${key}`, count: value });
      if (envelope && nextFields.has(key)) pagination.push({ path: `${path}.${key}`, present: value !== null && value !== undefined && value !== '', ...(typeof value === 'boolean' ? { flag: value } : {}) });
      walk(value, `${path}.${key}`, depth + 1, insideCollection);
    }
  }
  walk(body, '$', 0);
  return { bodyKind: Array.isArray(body) ? 'array' : body === null ? 'null' : typeof body, fieldPaths: [...fields].sort(), fieldTypes, unrecognizedFieldKinds, encodedJson, collections, totals, pagination };
}

try {
  const browser = await chromium.connectOverCDP('http://company-browser:9222');
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => {
    try { return new URL(candidate.url()).origin === origin; } catch { return false; }
  });
  if (!page) throw new Error('COMPANY_PAGE_MISSING');
  if (networkOnly) {
    const initialIds = await page.evaluate(origin => Array.from(document.querySelectorAll('table'))[1] ? Array.from(document.querySelectorAll('table')[1].querySelectorAll('tbody tr')).flatMap(row => {
      const link = row.querySelectorAll('td')[1]?.querySelector('a[href]');
      if (!link) return [];
      try { const url = new URL(link.getAttribute('href'), origin); return url.origin === origin && /^\/manage\/members\/[A-Za-z0-9_-]+$/.test(url.pathname) ? [url.pathname.split('/').at(-1)] : []; } catch { return []; }
    }) : [], origin);
    visibleIds = new Set(initialIds);
  }
  const onResponse = response => {
    const promise = (async () => {
      const request = response.request();
      if (!(networkOnly ? ['document', 'xhr', 'fetch'] : ['xhr', 'fetch']).includes(request.resourceType()) || !networkOnly && !['GET', 'HEAD'].includes(request.method())) return;
      let url;
      try { url = new URL(response.url()); } catch { return; }
      if (!(url.hostname === 'biz-pt.com' || url.hostname.endsWith('.biz-pt.com')) || /auth|token|session|login|logout|signin|refresh|oauth|credential|profile|\/me(?:\/|$)/i.test(url.pathname)) return;
      if (networkOnly) {
        // Only this explicitly authorized response media-type header is read; never request headers.
        const mediaType = ((await response.headerValue('content-type')) ?? '').split(';')[0].trim().toLowerCase();
        const allowedMediaTypes = new Set(['application/json', 'application/problem+json', 'text/html', 'text/x-component', 'text/plain', 'application/octet-stream']);
        networkMetadata.push({ method: request.method(), resourceType: request.resourceType(), status: response.status(), contentType: allowedMediaTypes.has(mediaType) ? mediaType : 'other', ...safeUrl(url.href) });
        if (!['application/json', 'application/problem+json'].includes(mediaType)) return;
      }
      // Body inspection is restricted to observed member/survey/withdrawal resource families.
      if (!networkOnly && !/\/(?:members?|survey|self-withdrawals|withdrawal-requests)(?:\/|$)/i.test(url.pathname)) return;
      const routeKind = currentRoute;
      let body;
      try { body = await response.json(); } catch { return; }
      if (url.pathname === '/api/survey/special-videos') surveyResponseBody = body;
      const summary = { routeKind, transport: { ...safeUrl(url.href), status: response.status(), resourceType: request.resourceType(), method: request.method() }, schema: summarizeBody(body) };
      const identity = JSON.stringify(summary);
      if (!seenResponses.has(identity)) { seenResponses.add(identity); summaries.push(summary); }
    })().catch(() => {});
    pending.add(promise); promise.finally(() => pending.delete(promise));
  };
  page.on('response', onResponse);
  const domSummaries = [];
  let activeHrefs = [];
  for (const route of knownPaths) {
    currentRoute = route === knownPaths[0] ? 'members' : route === knownPaths[1] ? 'self-withdrawals' : 'withdrawal-requests';
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    const captured = await page.evaluate(({ origin, activeText, allText, withdrawnText }) => {
      const tables = Array.from(document.querySelectorAll('table'));
      const rows = tables[1] ? Array.from(tables[1].querySelectorAll('tbody tr')) : [];
      const boxes = Array.from(document.querySelectorAll('[role="combobox"]'));
      const hrefs = rows.flatMap(row => {
        const links = row.querySelectorAll('td')[1]?.querySelectorAll('a[href]') ?? [];
        if (links.length !== 1) return [];
        try {
          const url = new URL(links[0].getAttribute('href'), origin);
          return url.origin === origin && /^\/manage\/members\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.search && !url.hash ? [url.href] : [];
        } catch { return []; }
      });
      const fixedHeaderSet = new Set(['번호', 'UID', '이름', '고정 스케줄', '회원유형', '전화번호', '강의 수강', '이메일', '담당 트레이너', '진행 여부', '운영정책 동의서', '주차', '회차', '재결제일', '최초 등록 일자', '상품명', '센터', '주 차', '탈퇴 언급 날짜', '신청 구분', '요청 처리', '탈퇴 구분', '신청 상태', '탈퇴 신청자', '상세 보기']);
      const safeHeaders = tables[0] ? Array.from(tables[0].querySelectorAll('thead th'), node => fixedHeaderSet.has(node.textContent?.trim()) ? node.textContent.trim() : '<unrecognized-header>') : [];
      const markerAttributes = ['data-user-id', 'data-account-id', 'data-trainer-id', 'data-manager-id', 'data-center-id'];
      const stableMarkerPresence = Object.fromEntries(markerAttributes.map(attribute => [attribute, document.querySelectorAll(`[${attribute}]`).length]));
      const progressCells = location.pathname === '/manage/members' ? rows.map(row => row.querySelectorAll('td')[9]).filter(Boolean) : [];
      const firstProgressCell = progressCells[0];
      const safeAttributes = new Set(['class', 'id', 'role', 'type', 'disabled', 'aria-label', 'aria-selected', 'aria-expanded', 'data-state', 'data-value']);
      const progressStructure = firstProgressCell ? Array.from(firstProgressCell.querySelectorAll('*')).slice(0, 25).map(node => ({ tag: node.tagName, role: node.getAttribute('role'), childElements: node.children.length, activeExact: node.textContent?.trim() === activeText, withdrawnExact: node.textContent?.trim() === withdrawnText, attributeNames: Array.from(node.attributes, attribute => attribute.name).filter(name => safeAttributes.has(name)) })) : [];
      const paginationNodes = Array.from(document.querySelectorAll('button,a,[role="button"]')).filter(node => /^(next|prev|previous|다음|이전)$/i.test((node.getAttribute('aria-label') ?? node.textContent ?? '').trim()));
      const text = document.body.textContent ?? '';
      const totalMarkers = [...text.matchAll(/(?:총|전체)\s*(\d+)\s*(?:명|건|개)/g)].map(match => Number(match[1])).filter(Number.isSafeInteger);
      return { hrefs, summary: {
        routePath: ['/manage/members', '/manage/self-withdrawals', '/manage/withdrawal-requests'].includes(location.pathname) ? location.pathname : '<redirected>', passwordInputs: document.querySelectorAll('input[type="password"]').length,
        tableCount: tables.length, headers: safeHeaders, rowCount: rows.length,
        rowCellCounts: [...new Set(rows.map(row => row.querySelectorAll('td').length))],
        canonicalUidLinks: hrefs.length, comboboxCount: boxes.length,
        comboboxMarkers: boxes.map(node => node.textContent?.trim() === activeText ? 'active' : node.textContent?.trim() === allText ? 'all' : node.textContent?.trim() === withdrawnText ? 'withdrawn' : node.textContent?.trim() === '' ? 'empty' : 'other-redacted'),
        paginationControls: paginationNodes.length, disabledPaginationControls: paginationNodes.filter(node => node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true').length,
        totalCountMarkers: totalMarkers, stableMarkerPresence,
        exactActiveProgressCells: progressCells.filter(node => node.textContent?.trim() === activeText).length,
        cellsContainingActiveProgress: progressCells.filter(node => node.textContent?.includes(activeText)).length,
        cellsWithActiveLeaf: progressCells.filter(node => Array.from(node.querySelectorAll('*')).some(child => child.children.length === 0 && child.textContent?.trim() === activeText)).length,
        firstProgressCellStructure: progressStructure,
      } };
    }, { origin, activeText, allText, withdrawnText });
    if (route === knownPaths[0]) {
      activeHrefs = captured.hrefs;
      visibleIds = new Set(activeHrefs.map(href => new URL(href).pathname.split('/').at(-1)));
    }
    domSummaries.push(captured.summary);
    console.log(JSON.stringify({ phase: 'dom', ...captured.summary }));
  }
  // The member IDs below are observed canonical links and stay in this process only.
  const survey = { inspectedMembers: 0, emptyOnlyTables: 0, nonemptyTables: 0, malformedTables: 0, activeTabMatches: 0, stableQuestionAnswerShapeObserved: false };
  const startIndex = focused ? Math.max(0, Math.min(1000, Number(process.env.COMPANY_INSPECT_START_INDEX ?? '0'))) : 0;
  for (const href of networkOnly ? [] : activeHrefs.slice(startIndex)) {
    currentRoute = 'specialVideos';
    surveyResponseBody = undefined;
    const url = new URL(href); url.search = '?tab=specialVideos';
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const result = await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"][aria-selected="true"]');
      const panels = document.querySelectorAll('[role="tabpanel"][data-state="active"]');
      const panel = panels.length === 1 ? panels[0] : null;
      const headers = panel ? Array.from(panel.querySelectorAll('thead th'), node => node.textContent?.trim()) : [];
      const rows = panel ? Array.from(panel.querySelectorAll('tbody tr')) : [];
      const cells = rows.map(row => row.querySelectorAll('td'));
      const valid = headers.length === 2 && headers[0] === '회차' && headers[1] === '답변' && rows.length > 0 && cells.every(row => row.length === 2);
      const empty = valid && cells.every(row => row[1].textContent === '미제출');
      const nonemptyCell = valid ? cells.find(row => row[1].textContent !== '미제출')?.[1] : null;
      const paragraphs = nonemptyCell ? Array.from(nonemptyCell.querySelectorAll(':scope > div > p')) : [];
      const textNodeShape = paragraphs.map(paragraph => Array.from(paragraph.childNodes));
      const labelSets = valid ? cells.filter(row => row[1].textContent !== '미제출').map(row => Array.from(row[1].querySelectorAll(':scope > div > p'), paragraph => paragraph.childNodes[0]?.textContent ?? '')) : [];
      const firstLabels = labelSets[0] ?? [];
      const questionAnswerStructure = {
        paragraphs: paragraphs.length,
        exactlyTwoTextNodes: textNodeShape.filter(nodes => nodes.length === 2 && nodes.every(node => node.nodeType === 3)).length,
        firstNodeEndsWithColon: textNodeShape.filter(nodes => /[:：]\s*$/.test(nodes[0]?.textContent ?? '')).length,
        firstNodeNonempty: textNodeShape.filter(nodes => Boolean(nodes[0]?.textContent?.trim())).length,
        secondNodePresent: textNodeShape.filter(nodes => nodes[1]?.nodeType === 3).length,
        submittedRoundContainers: labelSets.length,
        matchingQuestionLabelSequences: labelSets.filter(labels => labels.length === firstLabels.length && labels.every((label, index) => label === firstLabels[index])).length,
      };
      const safeClasses = new Set(['flex', 'flex-col', 'gap-[30px]', 'leading-[150%]', 'font-bold', 'font-semibold', 'whitespace-pre-wrap', 'text-sm', 'text-base']);
      function shape(node, path, depth) {
        if (!node || depth > 4) return [];
        const children = Array.from(node.children);
        return [{ path, tag: node.tagName, childElements: children.length, directTextNodes: Array.from(node.childNodes).filter(child => child.nodeType === 3 && child.textContent?.trim()).length, safeClasses: Array.from(node.classList).filter(name => safeClasses.has(name)), otherClassCount: Array.from(node.classList).filter(name => !safeClasses.has(name)).length }, ...children.flatMap((child, index) => shape(child, `${path}>${child.tagName.toLowerCase()}:nth-child(${index + 1})`, depth + 1))];
      }
      return { selectedTabMatches: tabs.length === 1 && tabs[0].textContent?.trim() === '특별 무료 강의 답변 확인', valid, empty, questionAnswerStructure, privateParagraphNodeParts: textNodeShape.map(nodes => nodes.map(node => ({ type: node.nodeType, text: node.textContent ?? '' }))), nonemptyStructure: nonemptyCell ? shape(nonemptyCell, 'answer-cell', 0) : [] };
    });
    survey.inspectedMembers++;
    if (result.selectedTabMatches) survey.activeTabMatches++;
    if (!result.valid) survey.malformedTables++;
    else if (result.empty) survey.emptyOnlyTables++;
    else survey.nonemptyTables++;
    if (focused && result.valid && !result.empty) {
      await Promise.allSettled([...pending]);
      const apiKeys = new Set(), apiValues = new Set();
      function collectApiParts(node, depth = 0) {
        if (!node || typeof node !== 'object' || depth > 5) return;
        for (const key of Object.keys(node)) {
          apiKeys.add(key);
          const value = node[key];
          if (['string', 'number', 'boolean'].includes(typeof value)) apiValues.add(String(value));
          else collectApiParts(value, depth + 1);
        }
      }
      collectApiParts(surveyResponseBody?.data);
      const paragraphs = result.privateParagraphNodeParts;
      const maximumNodes = Math.max(0, ...paragraphs.map(nodes => nodes.length));
      const apiMatching = {
        observedSurveyResponse: surveyResponseBody !== undefined,
        nodeTypeSequences: [...new Set(paragraphs.map(nodes => nodes.map(node => node.type).join(',')))],
        exactApiKeyMatchesByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && apiKeys.has(nodes[index].text)).length),
        exactApiValueMatchesByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && apiValues.has(nodes[index].text)).length),
        punctuationOnlyByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && /^\s*[:：]\s*$/.test(nodes[index].text)).length),
        whitespaceOnlyByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && /^\s*$/.test(nodes[index].text)).length),
        numericOnlyByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && /^\s*\d+\s*$/.test(nodes[index].text)).length),
        questionMarkByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && /[?？]/.test(nodes[index].text)).length),
        numberingPrefixByNodePosition: Array.from({ length: maximumNodes }, (_, index) => paragraphs.filter(nodes => nodes[index]?.type === 3 && /^\s*(?:Q\.?\s*\d+|\d+[.)])/i.test(nodes[index].text)).length),
      };
      console.log(JSON.stringify({ phase: 'nonempty-survey-structure', questionAnswerStructure: result.questionAnswerStructure, apiMatching, structure: result.nonemptyStructure }));
      break;
    }
  }
  if (!networkOnly) console.log(JSON.stringify({ phase: 'surveys', ...survey }));
  await Promise.allSettled([...pending]);
  if (networkOnly) {
    const methodCounts = {};
    for (const response of networkMetadata) methodCounts[response.method] = (methodCounts[response.method] ?? 0) + 1;
    console.log(JSON.stringify({ phase: 'observed-ui-response-methods', methodCounts, responses: networkMetadata }));
  }
  if (process.env.COMPANY_INSPECT_SCHEMA_OUTPUT !== '0') for (const summary of summaries) console.log(JSON.stringify({ phase: 'observed-api-schema', ...summary }));
  await page.goto(`${origin}/manage/members`, { waitUntil: 'domcontentloaded' });
  page.off('response', onResponse);
  console.log(JSON.stringify({ phase: 'complete', inspectedListRoutes: domSummaries.length, observedJsonResponseSchemas: summaries.length, pageRestoredToMembers: true, browserLeftRunning: true }));
  process.exit(0);
} catch {
  console.log(JSON.stringify({ phase: 'failed', code: 'COMPANY_READONLY_INSPECTION_FAILED' }));
  process.exit(1);
}
