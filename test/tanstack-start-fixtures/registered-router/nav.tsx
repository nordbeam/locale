// Checked first: a typed Link resolves the registered router before the root route has a type.
import { Link } from '@tanstack/react-router';

export const nav = <Link to="/about">About</Link>;
