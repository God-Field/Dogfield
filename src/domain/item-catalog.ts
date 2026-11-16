import type {ItemDefinition} from './models';

function cloneModel(model: ItemDefinition): ItemDefinition {
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(model)),
    model,
  );
  return clone;
}

export class ItemCatalog {
  readonly models: ItemDefinition[] = [];
  private giftRateTotal = 0;

  get totalGiftRate(): number {
    return this.giftRateTotal;
  }

  get length(): number {
    return this.models.length;
  }

  add(model: ItemDefinition): ItemDefinition {
    this.models.push(model);
    this.giftRateTotal += model.giftRate;
    return model;
  }

  clear(): void {
    this.models.length = 0;
    this.giftRateTotal = 0;
  }

  recalculateGiftRates(): void {
    this.giftRateTotal = this.models.reduce((total, model) => total + model.giftRate, 0);
  }

  snapshot(): ItemDefinition[] {
    return this.models.map(cloneModel);
  }

  restore(snapshot: readonly ItemDefinition[]): void {
    this.models.length = 0;
    for (const model of snapshot) {
      this.models.push(cloneModel(model));
    }
    this.recalculateGiftRates();
  }

  requireModel(index: number): ItemDefinition {
    if (!Number.isInteger(index) || index < 0 || index >= this.models.length) {
      throw new RangeError(`Invalid item model index: ${index}`);
    }
    return this.models[index];
  }

  findByIndex(index: number): ItemDefinition | null {
    return index >= 0 && index < this.models.length ? this.models[index] : null;
  }

  findById(id: number): ItemDefinition | null {
    return this.models.find(model => model.id === id) ?? null;
  }

  find(predicate: (model: ItemDefinition) => boolean): ItemDefinition | undefined {
    return this.models.find(predicate);
  }

  filter(predicate: (model: ItemDefinition) => boolean): ItemDefinition[] {
    return this.models.filter(predicate);
  }
}

export const defaultItemCatalog = new ItemCatalog();
