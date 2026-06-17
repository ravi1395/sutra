(function_definition name: (identifier) @name) @decl.function
(class_definition name: (identifier) @name) @decl.class
(assignment left: (identifier) @name) @decl.variable
(decorated_definition (function_definition name: (identifier) @name)) @decl.function
