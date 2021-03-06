'use strict';

const LinkParser = require('./links');
const { EOL } = require('os');
/**
 * @typedef {{reviewer: Collaborator}} Reviewer
 */
class MetadataGenerator {
  /**
   * @param {PRData} data
   */
  constructor(data) {
    const { repo, pr, reviewers } = data;
    this.repo = repo;
    this.pr = pr;
    this.reviewers = reviewers;
  }

  /**
   * @returns {string}
   */
  getMetadata() {
    const {
      reviewers: { approved: reviewedBy },
      pr: { url: prUrl, bodyHTML: op },
      repo
    } = this;

    const parser = new LinkParser(repo, op);
    const fixes = parser.getFixes();
    const refs = parser.getRefs();

    const output = {
      prUrl, reviewedBy, fixes, refs
    };

    let meta = [
      `PR-URL: ${output.prUrl}`
    ];
    meta = meta.concat(output.fixes.map((fix) => `Fixes: ${fix}`));
    meta = meta.concat(output.refs.map((ref) => `Refs: ${ref}`));
    meta = meta.concat(output.reviewedBy.map((r) => {
      return `Reviewed-By: ${r.reviewer.getContact()}`;
    }));

    return meta.join(EOL);
  }
}

MetadataGenerator.SCISSORS = [
  '-------------------------------- >8 --------------------------------',
  '-------------------------------- 8< --------------------------------'
];

module.exports = MetadataGenerator;
