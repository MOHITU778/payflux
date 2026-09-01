'use strict';

const { NotFoundError, ConflictError } = require('../errors');

/**
 * Generic data-access base class.
 *
 * The repository layer exists so services speak in domain terms and never in
 * Mongoose terms. Nothing above this layer imports a model, builds a query, or
 * knows what a `session` is — which is what makes the services unit-testable
 * against a fake repository and keeps a future storage change contained.
 *
 * `.lean()` is the default on reads: hydrating full Mongoose documents costs
 * roughly 3–5× the CPU of a plain object, and services only need data.
 */
class BaseRepository {
  /** @param {import('mongoose').Model} model */
  constructor(model) {
    this.model = model;
    this.name = model.modelName;
  }

  /**
   * @param {object} data
   * @param {{session?: import('mongoose').ClientSession}} [opts]
   */
  async create(data, opts = {}) {
    try {
      const [doc] = await this.model.create([data], { session: opts.session });
      return doc.toObject ? doc.toObject() : doc;
    } catch (err) {
      throw this.translateDuplicateKey(err);
    }
  }

  async insertMany(docs, opts = {}) {
    return this.model.insertMany(docs, { session: opts.session, ordered: opts.ordered ?? true });
  }

  async findById(id, opts = {}) {
    return this.model.findById(id).session(opts.session ?? null).lean(opts.lean !== false);
  }

  async findOne(filter, opts = {}) {
    let query = this.model.findOne(filter).session(opts.session ?? null);
    if (opts.select) query = query.select(opts.select);
    if (opts.populate) query = query.populate(opts.populate);
    if (opts.sort) query = query.sort(opts.sort);
    return query.lean(opts.lean !== false);
  }

  /** Like `findOne`, but throws a 404 instead of returning null. */
  async findOneOrFail(filter, opts = {}) {
    const doc = await this.findOne(filter, opts);
    if (!doc) throw new NotFoundError(this.name);
    return doc;
  }

  async find(filter, opts = {}) {
    let query = this.model.find(filter).session(opts.session ?? null);
    if (opts.sort) query = query.sort(opts.sort);
    if (opts.skip) query = query.skip(opts.skip);
    if (opts.limit) query = query.limit(opts.limit);
    if (opts.select) query = query.select(opts.select);
    if (opts.populate) query = query.populate(opts.populate);
    return query.lean(opts.lean !== false);
  }

  async count(filter = {}) {
    return this.model.countDocuments(filter);
  }

  /**
   * One page of results plus its total.
   *
   * The count and the fetch are issued concurrently — they are independent
   * reads, and serialising them would double the latency of every list view.
   */
  async paginate(filter, { page = 1, limit = 20, sort = { createdAt: -1 }, select, populate } = {}) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.find(filter, { sort, skip, limit, select, populate }),
      this.count(filter),
    ]);
    return { items, total, page, limit };
  }

  async updateOne(filter, update, opts = {}) {
    try {
      return await this.model
        .findOneAndUpdate(filter, update, {
          new: opts.new !== false,
          session: opts.session ?? null,
          runValidators: true,
          ...opts,
        })
        .lean(opts.lean !== false);
    } catch (err) {
      throw this.translateDuplicateKey(err);
    }
  }

  async updateById(id, update, opts = {}) {
    return this.updateOne({ _id: id }, update, opts);
  }

  async updateMany(filter, update, opts = {}) {
    return this.model.updateMany(filter, update, { session: opts.session ?? null });
  }

  async deleteOne(filter, opts = {}) {
    return this.model.deleteOne(filter, { session: opts.session ?? null });
  }

  async exists(filter) {
    return Boolean(await this.model.exists(filter));
  }

  async aggregate(pipeline, opts = {}) {
    return this.model.aggregate(pipeline).session(opts.session ?? null);
  }

  /**
   * Start a session, run `fn` inside a transaction, and commit or abort.
   *
   * Requires a replica set. Callers that must work on a standalone Mongo pass
   * `session` through as `null` and rely on the idempotency keys that guard
   * every write instead.
   */
  async withTransaction(fn) {
    const session = await this.model.db.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await fn(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Convert Mongo's E11000 into a domain ConflictError.
   * The raw driver error leaks the index definition and the offending values,
   * neither of which belongs in an API response.
   */
  translateDuplicateKey(err) {
    if (err && err.code === 11000) {
      const field = Object.keys(err.keyPattern || {}).join(', ') || 'unique field';
      return new ConflictError(`${this.name} already exists for ${field}`, { field });
    }
    return err;
  }
}

module.exports = BaseRepository;
