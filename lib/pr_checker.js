'use strict';

const SECOND = 1000;
const MINUTE = SECOND * 60;
const HOUR = MINUTE * 60;

const SUNDAY = 0;
const SATURDAY = 6;

const WEEKDAY_WAIT = 48;
const WEEKEND_WAIT = 72;

const {
  REVIEW_SOURCES: { FROM_COMMENT }
} = require('./reviews');
const {
  FIRST_TIME_CONTRIBUTOR, FIRST_TIMER
} = require('./user_status');

const CIParser = require('./ci');
const CI_TYPES = CIParser.TYPES;
const { FULL } = CIParser.constants;

class PRChecker {
  /**
   * @param {{}} logger
   * @param {PRData} data
   */
  constructor(logger, data) {
    this.logger = logger;
    const {
      pr, reviewers, comments, reviews, commits, collaborators
    } = data;
    this.reviewers = reviewers;
    this.pr = pr;
    this.comments = comments;
    this.reviews = reviews;
    this.commits = commits;
    this.collaboratorEmails = new Set(
      Array.from(collaborators).map((c) => c[1].email)
    );
  }

  checkAll() {
    const status = [
      this.checkReviews(),
      this.checkPRWait(new Date()),
      this.checkCI()
    ];

    if (this.authorIsNew()) {
      status.push(this.checkAuthor());
    }
    // TODO: maybe invalidate review after new commits?
    // TODO: check for pre-backport, Github API v4
    // does not support reading files changed

    return status.every((i) => i);
  }

  getTSCHint(people) {
    const tsc = people
      .filter((p) => p.reviewer.isTSC())
      .map((p) => p.reviewer.login);
    let hint = '';
    if (tsc.length > 0) {
      const list = `(${tsc.join(', ')})`;
      hint = `, ${tsc.length} from TSC ${list}`;
    }
    return hint;
  }

  checkReviews() {
    const {
      pr, logger, reviewers: { rejected, approved }
    } = this;
    let status = true;

    if (rejected.length === 0) {
      logger.info(`Rejections: 0`);
    } else {
      status = false;
      let hint = this.getTSCHint(rejected);
      logger.warn(`Rejections: ${rejected.length}${hint}`);
      for (const { reviewer, review } of rejected) {
        logger.warn(`${reviewer.getName()}) rejected in ${review.ref}`);
      }
    }
    if (approved.length === 0) {
      status = false;
      logger.warn(`Approvals: 0`);
    } else {
      let hint = this.getTSCHint(approved);
      logger.info(`Approvals: ${approved.length}${hint}`);

      for (const { reviewer, review } of approved) {
        if (review.source === FROM_COMMENT) {
          logger.info(`${reviewer.getName()}) approved in via LGTM in comments`);
        }
      }

      const labels = pr.labels.nodes.map((l) => l.name);
      if (labels.includes('semver-major')) {
        const tscApproval = approved.filter((p) => p.reviewer.isTSC()).length;
        if (tscApproval < 2) {
          status = false;
          logger.warn('semver-major requires at least two TSC approvals');
        }
      }
    }

    return status;
  }

  /**
   * @param {Date} now
   */
  getWait(now) {
    const createTime = new Date(this.pr.createdAt);
    const utcDay = now.getUTCDay();
    // TODO: do we need to lose this a bit considering timezones?
    const isWeekend = (utcDay === SUNDAY || utcDay === SATURDAY);
    const waitTime = isWeekend ? WEEKEND_WAIT : WEEKDAY_WAIT;
    const timeLeft = waitTime - Math.ceil(
      (now.getTime() - createTime.getTime()) / HOUR
    );

    return {
      isWeekend,
      timeLeft
    };
  }

  // TODO: skip some PRs...we might need a label for that
  /**
   * @param {Date} now
   */
  checkPRWait(now) {
    const { pr } = this;
    const { logger } = this;
    const wait = this.getWait(now);
    if (wait.timeLeft > 0) {
      const dateStr = new Date(pr.createdAt).toDateString();
      const type = wait.isWeekend ? 'weekend' : 'weekday';
      logger.info(`This PR was created on ${dateStr} (${type} in UTC)`);
      logger.warn(`${wait.timeLeft} hours left to land`);
      return false;
    }

    return true;
  }

  // TODO: we might want to check CI status when it's less flaky...
  // TODO: not all PR requires CI...labels?
  checkCI() {
    const { pr, logger, comments, reviews } = this;
    const prNode = {
      publishedAt: pr.createdAt,
      bodyText: pr.bodyText
    };
    const thread = comments.concat([prNode]).concat(reviews);
    const ciMap = new CIParser(thread).parse();
    let status = true;
    if (!ciMap.size) {
      logger.warn('No CI runs detected');
      return false;
    } else if (!ciMap.get(FULL)) {
      status = false;
      logger.warn('No full CI runs detected');
    }

    for (const [type, ci] of ciMap) {
      const name = CI_TYPES.get(type).name;
      logger.info(`Last ${name} CI on ${ci.date}: ${ci.link}`);
    }

    return status;
  }

  authorIsNew() {
    const assoc = this.pr.authorAssociation;
    return assoc === FIRST_TIME_CONTRIBUTOR || assoc === FIRST_TIMER;
  }

  checkAuthor() {
    const { logger, commits, pr } = this;

    const oddCommits = this.filterOddCommits(commits);
    if (!oddCommits.length) {
      return true;
    }

    const prAuthor = pr.author.login;
    logger.warn(`PR is opened by @${prAuthor}`);
    for (const c of oddCommits) {
      const { oid, author } = c.commit;
      const hash = oid.slice(0, 7);
      logger.warn(`Author ${author.email} of commit ${hash} ` +
                  `does not match committer or PR author`);
    }
    return false;
  }

  filterOddCommits(commits) {
    return commits.filter((c) => this.isOddAuthor(c.commit));
  }

  isOddAuthor(commit) {
    const { pr, collaboratorEmails } = this;
    // If they have added the alternative email to their account,
    // commit.authoredByCommitter should be set to true by Github
    if (commit.authoredByCommitter) {
      return false;
    }

    // The commit author is one of the collaborators, they should know
    // what they are doing anyway
    if (collaboratorEmails.has(commit.author.email)) {
      return false;
    }

    if (commit.author.email === pr.author.email) {
      return false;
    }

    // At this point, the commit:
    // 1. is not authored by the commiter i.e. author email is not in the
    //    committer's Github account
    // 2. is not authored by a collaborator
    // 3. is not authored by the people opening the PR
    return true;
  }
}

module.exports = PRChecker;
