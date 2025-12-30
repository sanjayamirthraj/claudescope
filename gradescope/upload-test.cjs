const cheerio = require('cheerio');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const GRADESCOPE_BASE_URL = 'https://www.gradescope.com';

class GradescopeClient {
  constructor() {
    this.cookies = [];
    this.loggedIn = false;
  }

  getCookieHeader() {
    return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  parseCookies(setCookieHeaders) {
    for (const header of setCookieHeaders) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) {
        const existing = this.cookies.findIndex(c => c.name === match[1]);
        if (existing >= 0) {
          this.cookies[existing].value = match[2];
        } else {
          this.cookies.push({ name: match[1], value: match[2] });
        }
      }
    }
  }

  async loginWithCookies(cookieString) {
    const pairs = cookieString.split(';').map(s => s.trim());
    for (const pair of pairs) {
      const match = pair.match(/^([^=]+)=(.*)$/);
      if (match) {
        const existing = this.cookies.findIndex(c => c.name === match[1]);
        if (existing >= 0) {
          this.cookies[existing].value = match[2];
        } else {
          this.cookies.push({ name: match[1], value: match[2] });
        }
      }
    }
    const response = await fetch(`${GRADESCOPE_BASE_URL}/account`, {
      headers: { Cookie: this.getCookieHeader() },
      redirect: 'manual',
    });
    if (response.status === 200) {
      this.loggedIn = true;
      return true;
    }
    return false;
  }

  async getCourses() {
    if (!this.loggedIn) throw new Error('Not logged in');

    const response = await fetch(`${GRADESCOPE_BASE_URL}/account`, {
      headers: { Cookie: this.getCookieHeader() },
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    const courses = { instructor: [], student: [] };

    $('.courseList').each((_, list) => {
      const $list = $(list);
      const isInstructor =
        $list.prev('h1').text().toLowerCase().includes('instructor') ||
        $list.prev('h2').text().toLowerCase().includes('instructor');
      const courseArray = isInstructor ? courses.instructor : courses.student;

      $list.find('.courseBox').each((_, box) => {
        const $box = $(box);
        const href = $box.attr('href') || '';
        const idMatch = href.match(/\/courses\/(\d+)/);
        const id = idMatch ? idMatch[1] : '';
        const name = $box.find('.courseBox--shortname').text().trim();
        const term = $box.find('.courseBox--term').text().trim();

        if (id) {
          courseArray.push({ id, name, term });
        }
      });
    });

    return courses;
  }

  async getAssignments(courseId) {
    if (!this.loggedIn) throw new Error('Not logged in');

    const response = await fetch(
      `${GRADESCOPE_BASE_URL}/courses/${courseId}`,
      { headers: { Cookie: this.getCookieHeader() } }
    );
    const html = await response.text();
    const $ = cheerio.load(html);

    const assignments = [];

    $('table.table tbody tr').each((_, row) => {
      const $row = $(row);
      const $link = $row.find('th a, td a').first();
      const href = $link.attr('href') || '';
      const idMatch = href.match(/\/assignments\/(\d+)/);
      const id = idMatch ? idMatch[1] : '';
      const name = $link.text().trim();

      if (id && name) {
        assignments.push({ id, name });
      }
    });

    $('.assignments-student-table tr, .assignmentsTable tr').each((_, row) => {
      const $row = $(row);
      const $link = $row.find('a').first();
      const href = $link.attr('href') || '';
      const idMatch = href.match(/\/assignments\/(\d+)/);
      const id = idMatch ? idMatch[1] : '';
      const name = $link.text().trim() || $row.find('th').first().text().trim();

      if (id && name && !assignments.find(a => a.id === id)) {
        assignments.push({ id, name });
      }
    });

    return assignments;
  }

  async uploadSubmission(courseId, assignmentId, filePaths) {
    if (!this.loggedIn) throw new Error('Not logged in');

    const courseUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}`;
    const assignmentUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}`;

    // First, check the assignment page to get CSRF token and detect existing submission
    const assignmentResponse = await fetch(assignmentUrl, {
      headers: { Cookie: this.getCookieHeader() },
      redirect: 'follow',
    });
    const assignmentHtml = await assignmentResponse.text();
    const $ = cheerio.load(assignmentHtml);
    const authToken = $('meta[name="csrf-token"]').attr('content') || '';

    // Check if there's an existing submission by looking at the final URL or form action
    const finalAssignmentUrl = assignmentResponse.url;
    const existingSubmissionMatch = finalAssignmentUrl.match(/\/submissions\/(\d+)/);

    // Extract resubmit_path from the JSON data embedded in the page
    const decoded = assignmentHtml.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const resubmitPathMatch = decoded.match(/"resubmit_path":"([^"]+)"/);

    let uploadUrl;
    if (resubmitPathMatch) {
      uploadUrl = `${GRADESCOPE_BASE_URL}${resubmitPathMatch[1]}`;
      console.log('Using resubmit_path from JSON:', uploadUrl);
    } else if (existingSubmissionMatch) {
      // Fallback: use the submissions endpoint
      uploadUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}/submissions`;
      console.log('Using submissions URL (fallback):', uploadUrl);
    } else {
      uploadUrl = `${GRADESCOPE_BASE_URL}/courses/${courseId}/assignments/${assignmentId}/submissions`;
      console.log('Using new submission URL:', uploadUrl);
    }

    const form = new FormData();
    form.append('utf8', '✓');
    form.append('authenticity_token', authToken);

    for (const filePath of filePaths) {
      const absolutePath = path.resolve(filePath);
      if (!fs.existsSync(absolutePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }
      const fileStream = fs.createReadStream(absolutePath);
      const fileName = path.basename(absolutePath);
      // Use 'files[]' - Rails array convention
      form.append('files[]', fileStream, fileName);
    }

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Cookie: this.getCookieHeader(),
        Referer: finalAssignmentUrl,  // Use the actual submission page URL as referer
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        'Origin': 'https://www.gradescope.com',
        'X-Requested-With': 'XMLHttpRequest',
        ...form.getHeaders(),
      },
      body: form,
      redirect: 'follow',
    });

    const finalUrl = response.url;
    const responseText = await response.text();

    console.log('Response status:', response.status);
    console.log('Final URL:', finalUrl);
    console.log('Response body (first 2000 chars):', responseText.substring(0, 2000));

    if (finalUrl === courseUrl || finalUrl.endsWith('submissions')) {
      return {
        success: false,
        error: 'Upload failed - possibly past due date or invalid submission',
      };
    }

    return { success: true, url: finalUrl };
  }
}

async function getAssignmentPage(client, courseId, assignmentId) {
  const response = await fetch(
    `https://www.gradescope.com/courses/${courseId}/assignments/${assignmentId}`,
    { headers: { Cookie: client.getCookieHeader() } }
  );
  return response.text();
}

async function getSubmissions(client, courseId, assignmentId) {
  const submissionsUrl = `https://www.gradescope.com/courses/${courseId}/assignments/${assignmentId}/submissions`;
  const response = await fetch(submissionsUrl, {
    headers: { Cookie: client.getCookieHeader() },
  });
  const html = await response.text();
  const $ = cheerio.load(html);

  const submissions = [];

  // Get assignment name from the page
  const assignmentName = $('h1, .assignment-title, .assignmentTitle').first().text().trim() || 'Unknown Assignment';

  // Parse submission history table
  $('.submissionHistoryTable tr, table.table tbody tr, .submission-history tr').each((index, row) => {
    const $row = $(row);

    // Skip header rows
    if ($row.find('th').length > 0) return;

    const $link = $row.find('a').first();
    const href = $link.attr('href') || '';
    const idMatch = href.match(/\/submissions\/(\d+)/);
    const id = idMatch ? idMatch[1] : '';

    if (!id) return;

    // Get submission time
    const timeElem = $row.find('time');
    const submittedAt = timeElem.attr('datetime') || timeElem.text().trim() || $row.find('td').eq(0).text().trim();

    // Get score
    const scoreText = $row.find('.score, .submissionScore').text().trim();
    const score = scoreText.match(/[\d.]+\s*\/\s*[\d.]+/) ? scoreText : '';

    // Get status
    let status = '';
    $row.find('td').each((_, cell) => {
      const text = $(cell).text().trim();
      if (text.includes('Graded') || text.includes('Submitted') || text.includes('Processing') || text.includes('Pending')) {
        status = text;
      }
    });

    submissions.push({
      id,
      submittedAt,
      score,
      status: status || 'Submitted',
      isLatest: submissions.length === 0,
    });
  });

  // Also check for single submission display
  if (submissions.length === 0) {
    const singleSubmissionLink = $("a[href*='/submissions/']").first();
    const href = singleSubmissionLink.attr('href') || '';
    const idMatch = href.match(/\/submissions\/(\d+)/);
    if (idMatch) {
      submissions.push({
        id: idMatch[1],
        submittedAt: $('time').first().text().trim() || 'Unknown',
        score: $('.score').first().text().trim() || '',
        status: 'Submitted',
        isLatest: true,
      });
    }
  }

  return {
    submissions,
    assignmentName,
    hasSubmission: submissions.length > 0,
  };
}

async function resubmit(client, courseId, assignmentId, filePaths) {
  // First, get existing submissions
  const existingSubmissions = await getSubmissions(client, courseId, assignmentId);

  let response = '';

  if (existingSubmissions.hasSubmission) {
    response += `Previous submissions found for: ${existingSubmissions.assignmentName}\n`;
    response += `Number of previous submissions: ${existingSubmissions.submissions.length}\n`;

    const latest = existingSubmissions.submissions.find(s => s.isLatest);
    if (latest) {
      response += `Latest submission: #${latest.id} at ${latest.submittedAt}`;
      if (latest.score) {
        response += ` (Score: ${latest.score})`;
      }
      response += '\n';
    }
    response += '\n--- Uploading new submission ---\n\n';
  } else {
    response += `No previous submissions found for: ${existingSubmissions.assignmentName}\n`;
    response += 'This will be your first submission.\n\n';
  }

  // Now upload the new submission
  const uploadResult = await client.uploadSubmission(courseId, assignmentId, filePaths);

  if (uploadResult.success) {
    response += `Resubmission successful!\n`;
    response += `New submission URL: ${uploadResult.url}\n`;
    response += `\nYour previous ${existingSubmissions.submissions.length} submission(s) are preserved in the history.`;
  } else {
    response += `Resubmission failed: ${uploadResult.error}`;
  }

  return response;
}

async function main() {
  const action = process.argv[2];
  const client = new GradescopeClient();

  // Get cookies from environment
  const sessionCookie = process.env.GRADESCOPE_SESSION;
  const signedToken = process.env.GRADESCOPE_TOKEN;

  if (!sessionCookie || !signedToken) {
    console.log('Error: GRADESCOPE_SESSION and GRADESCOPE_TOKEN environment variables required');
    process.exit(1);
  }

  const cookieString = `_gradescope_session=${sessionCookie}; signed_token=${signedToken}`;
  const loggedIn = await client.loginWithCookies(cookieString);

  if (!loggedIn) {
    console.log('Failed to login to Gradescope');
    process.exit(1);
  }

  console.log('Logged in to Gradescope!');

  if (action === 'courses') {
    const courses = await client.getCourses();
    console.log(JSON.stringify(courses, null, 2));
  } else if (action === 'assignments') {
    const courseId = process.argv[3];
    if (!courseId) {
      console.log('Usage: node upload-test.js assignments <courseId>');
      process.exit(1);
    }
    const assignments = await client.getAssignments(courseId);
    console.log(JSON.stringify(assignments, null, 2));
  } else if (action === 'upload') {
    const courseId = process.argv[3];
    const assignmentId = process.argv[4];
    const filePath = process.argv[5];
    if (!courseId || !assignmentId || !filePath) {
      console.log('Usage: node upload-test.js upload <courseId> <assignmentId> <filePath>');
      process.exit(1);
    }
    const result = await client.uploadSubmission(courseId, assignmentId, [filePath]);
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'view') {
    const courseId = process.argv[3];
    const assignmentId = process.argv[4];
    if (!courseId || !assignmentId) {
      console.log('Usage: node upload-test.cjs view <courseId> <assignmentId>');
      process.exit(1);
    }
    const html = await getAssignmentPage(client, courseId, assignmentId);
    // Print relevant parts - look for submission info
    const $ = cheerio.load(html);
    console.log('Page title:', $('title').text());
    console.log('');
    console.log('Forms found:', $('form').length);
    $('form').each((i, f) => {
      console.log(`  Form ${i}: action=${$(f).attr('action')}, method=${$(f).attr('method')}`);
    });
    console.log('');
    // Look for submission-related info
    console.log('Submit buttons:', $('button[type="submit"], input[type="submit"]').length);
    console.log('File inputs:', $('input[type="file"]').length);
    console.log('');
    // Check for error/info messages
    const alerts = $('.alert, .flash, .notice, .error, .warning').text().trim();
    if (alerts) console.log('Alerts:', alerts);
    // Print the main content area
    console.log('\\n--- Main content (first 3000 chars) ---');
    const mainContent = $('main, .main-content, #content, .content').first().text().trim();
    console.log(mainContent.substring(0, 3000));
  } else if (action === 'submissions') {
    const courseId = process.argv[3];
    const assignmentId = process.argv[4];
    if (!courseId || !assignmentId) {
      console.log('Usage: node upload-test.cjs submissions <courseId> <assignmentId>');
      process.exit(1);
    }
    const result = await getSubmissions(client, courseId, assignmentId);
    console.log(JSON.stringify(result, null, 2));
  } else if (action === 'resubmit') {
    const courseId = process.argv[3];
    const assignmentId = process.argv[4];
    const filePath = process.argv[5];
    if (!courseId || !assignmentId || !filePath) {
      console.log('Usage: node upload-test.cjs resubmit <courseId> <assignmentId> <filePath>');
      process.exit(1);
    }
    const result = await resubmit(client, courseId, assignmentId, [filePath]);
    console.log(result);
  } else {
    console.log('Usage:');
    console.log('  node upload-test.cjs courses');
    console.log('  node upload-test.cjs assignments <courseId>');
    console.log('  node upload-test.cjs upload <courseId> <assignmentId> <filePath>');
    console.log('  node upload-test.cjs view <courseId> <assignmentId>');
    console.log('  node upload-test.cjs submissions <courseId> <assignmentId>');
    console.log('  node upload-test.cjs resubmit <courseId> <assignmentId> <filePath>');
  }
}

main().catch(console.error);
