'use strict';

const BaseRepository = require('./base.repository');
const { AuditLog } = require('../models');

class AuditRepository extends BaseRepository {
  constructor() { super(AuditLog); }

  list(filter, page) {
    return this.paginate(filter, { ...page, sort: { createdAt: -1 } });
  }

  forTarget(targetType, targetId) {
    return this.find({ 'target.type': targetType, 'target.id': targetId }, { sort: { createdAt: -1 } });
  }
}

module.exports = new AuditRepository();
module.exports.AuditRepository = AuditRepository;
