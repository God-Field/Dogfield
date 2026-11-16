import { Store } from './store.ts';
import { randomBytes } from 'node:crypto';
import { requireValue } from './errors.ts';
import { createRandomId } from './ids.ts';

export class AccountService {
  constructor(private readonly store: Store) {}
  create() {
    const userId = createRandomId(28);
    const token = randomBytes(32).toString('hex');
    this.store.accounts.set(token, {
      uid: userId,
    });
    this.store.save();
    return {
      uid: userId,
      token,
    };
  }

  authenticate(token: string | null | undefined) {
    const account = this.store.accounts.get(token ?? '');
    requireValue(account, 403);
    return account.uid;
  }

  delete(userId: string) {
    for (const [token, account] of this.store.accounts) {
      if (account.uid === userId) {
        this.store.accounts.delete(token);
      }
    }
    this.store.delete(`records/${userId}`);
    this.store.save();
  }
}
