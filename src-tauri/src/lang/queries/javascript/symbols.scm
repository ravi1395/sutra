(function_declaration name: (identifier) @name) @decl.function
(method_definition name: (property_identifier) @name) @decl.function
(class_declaration name: (identifier) @name) @decl.class
(lexical_declaration (variable_declarator name: (identifier) @name)) @decl.variable
