import type { PageDto, PageQueryDto } from './pagination.dto';

export async function readPage<T>(
  { page, pageSize }: PageQueryDto,
  total: number,
  read: (skip: number, take: number) => Promise<T[]>,
): Promise<PageDto & { items: T[] }> {
  const lastPage = Math.ceil(total / pageSize);
  const items = page > lastPage ? [] : await read((page - 1) * pageSize, pageSize);
  return { items, ...pageInfo({ page, pageSize }, total) };
}

export function pageInfo({ page, pageSize }: PageQueryDto, total: number): PageDto {
  const lastPage = Math.ceil(total / pageSize);
  return { page, pageSize, total, previousPage: page > 1 ? page - 1 : null,
    nextPage: page < lastPage ? page + 1 : null };
}
