var GitHubApi = require('github'),
    debug = require('debug')('case-study-bot:bot'),
    config = require('./config');

var github = new GitHubApi({version: '3.0.0'});

/**
 * Private: Authenticate next request
 */
function _authenticate() {
    if ((!config.botUser || !config.botPassword) || (!config.oauth2key || !config.oauth2secret)) {
        throw Error('Fatal: No username/password or no Oauth2 key/secret configured!');
    }
    
    if (config.oauth2key && config.oauth2secret) {
        github.authenticate({
            type: 'oauth',
            key: config.oauth2key,
            secret: config.oauth2secret
        })
    } else {
        github.authenticate({
            type: 'basic',
            username: config.botUser,
            password: config.botPassword
        });
    }
}

/**
 * Fetch all (open) pull requests in the currently configured repo
 * @callback {getPullRequestsCb} callback
 */
function getPullRequests(callback) {
    /**
     * @callback getPullRequestsCb
     * @param {Object[]} result - Returned pull request objects
     */
    github.pullRequests.getAll({
        user: config.user,
        repo: config.repo,
        state: 'all'
    }, function(error, result) {
        if (error) {
            return debug('getPullRequests: Error while fetching PRs: ', error);
        }

        if (!result || !result.length || result.length < 1) {
            return debug('getPullRequests: No open PRs found');
        }
        
        if (callback) {
            callback(result);
        }
    });
}

/**
 * Get all the labels for a PR
 * @param {int} prNumber - Number of PR for which to get all the labels
 * @callback {checkForLabelCb} callback
 */
function checkForLabel(prNumber, callback) {
    /**
     * @callback checkForLabelCb
     * @param {Object} result - Object describing how the issue is labeled
     */
    if (!prNumber) {
        return debug('checkForLabel: insufficient parameters');
    }

    github.issues.getIssueLabels({
        user: config.user,
        repo: config.repo,
        number: prNumber
    }, function (error, result) {
        var labeledNeedsReview = false,
            labeledReviewed = false,
            labels = [];

        if (error) {
            return debug('checkForLabel: Error while fetching labels for single PR: ', error);
        }

        // Check if already labeled
        for (var i = 0; i < result.length; i++) {
            labeledNeedsReview = (result[i].name === config.labelNeedsReview) ? true : labeledNeedsReview;
            labeledReviewed = (result[i].name === config.labelReviewed) ? true : labeledReviewed;
            labels.push(result[i]);
        }
        
        if (callback) {
            callback({
                labeledNeedsReview: labeledNeedsReview,
                labeledReviewed: labeledReviewed,
                labels: labels
            })   
        }
    });
}

/**
 * Check a PR for 'LGTM!' comments
 * @param {int} prNumber - Number of PR to check
 * @callback {checkForApprovalComments} callback
 */
function checkForApprovalComments(prNumber, callback) {
    /**
     * @callback checkForApprovalCommentsCb
     * @param {boolean} approved - Approved or not?
     */
     if (!prNumber) {
         return debug('checkForApprovalComments: insufficient parameters');
     }

     github.issues.getComments({
         repo: config.repo,
         user: config.user,
         number: prNumber,
         perPage: 99
     }, function (error, result) {
        var lgtm = /(LGTM)|(Looks good to me!)|w+?/,
            approvedCount = 0,
            approved;

        if (error) {
            return debug('checkForApprovalComments: Error while fetching coments for single PR: ', error);
        }

        for (var i = 0; i < result.length; i++) {
            if (result[i].body && lgtm.test(result[i].body)) {
                approvedCount = approvedCount + 1;
            }
        }

        approved = (approvedCount >= config.reviewsNeeded);

        if (callback) {
            callback(approved);
        }
     });
}

/**
 * Check if a PR already has the instructions comment
 * @param {int} prNumber - Number of PR to check
 * @callback {checkForInstructionsCommentCb} callback
 */
function checkForInstructionsComment(prNumber, callback) {
    /**
     * @callback checkForInstructionsCommentCb
     * @param {boolean} posted - Comment posted or not?
     */
    github.issues.getComments({
        user: config.user,
        repo: config.repo,
        number: prNumber
    }, function (error, result) {
        var instructed = false;

        if (error) {
            return debug('commentInstructions: error while trying fetch comments: ', error);
        }

        for (var i = 0; i < result.length; i++) {
            instructed = (result[i].body.slice(1, 30).trim() === config.instructionsComment.slice(1, 30).trim());
            if (instructed) {
                break;
            }
        }

        if (callback) {
            callback(instructed);
        }
    });
}

/**
 * Label PR as approved / not approved yet
 * @param {int} prNumber - Number of PR
 * @param {boolean} approved - 'True' for 'peer-reviewed'
 * @param {sring[]} labels - Previously fetched labels
 * @callback {updateLabelsCb} callback
 */
function updateLabels(prNumber, approved, labels, callback) {
    /**
     * @callback updateLabelsCb
     * @param {Object} result - Result returned from GitHub
     */

    var changed = false;

    labels = (!labels || !labels.length) ? [] : labels;

    if ((approved !== true && approved !== false) || !prNumber) {
        return debug('labelPullRequest: insufficient parameters');
    }

    // Adjust labels for approved / not approved
    if (approved && labels.indexOf(config.labelNeedsReview) > -1) {
        labels.removeAt(labels.indexOf(config.labelNeedsReview));
        changed = true;
    } else if (approved && labels.indexOf(config.labelReviewed) === -1) {
        labels.push(config.labelReviewed);
        changed = true;
    }

    if (!approved && labels.indexOf(config.labelReviewed) > -1) {
        labels.removeAt(labels.indexOf(config.labelReviewed));
        changed = true;
    } else if (!approved && labels.indexOf(config.labelNeedsReview) === -1) {
        labels.push(config.labelNeedsReview);
        changed = true;
    }

    if (changed) {
        _authenticate();
        github.issues.edit({
            user: config.user,
            repo: config.repo,
            number: prNumber,
            labels: JSON.stringify(labels)
        }, function (error, result) {
            if (error) {
                return debug('labelPullRequest: error while trying to label PR: ', error);
            }
            if (callback) {
                callback(result);
            }
        });
    }
}

/**
 * Post the instructions comment to a PR
 * @param {int} prNumber - Number of the PR to post to
 * @callback {postInstructionsCommentCb} callback
 */
function postInstructionsComment(prNumber, callback) {
    /**
     * @callback postInstructionsCommentCb
     * @param {Object} result - Result returned from GitHub
     */
    _authenticate();
    github.issues.createComment({
        user: config.user,
        repo: config.repo,
        number: prNumber,
        body: config.instructionsComment
    }, function (error, result) {
        if (error) {
            return debug('postInstructionsComment: Error while trying to post instructions:', error);
        }
        if (callback) {
            callback(result);
        }
    });
}

/**
 * Merge a PR
 * @param {int} prNumber - Number of the PR to merge
 * @callback {mergeCb} callback
 */
function merge(prNumber, callback) {
    /**
     * @callback postInstructionsCommentCb
     * @param {mergeCb} result - Result returned from GitHub
     */
    _authenticate();
    github.pullRequests({
        user: config.user,
        repo: config.repo,
        number: prNumber
    }, function (error, result) {
        if (error) {
            return debug('merge: Error while trying to merge PR:', error);
        }
        if (callback) {
            callback(result);
        }
    });
}

module.exports = {
    getPullRequests: getPullRequests,
    checkForLabel: checkForLabel,
    checkForApprovalComments: checkForApprovalComments,
    checkForInstructionsComment: checkForInstructionsComment,
    updateLabels: updateLabels,
    postInstructionsComment: postInstructionsComment,
    merge: merge
};